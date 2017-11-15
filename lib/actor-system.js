/*
 * Copyright (c) 2016-2017 Untu, Inc.
 * This code is licensed under Eclipse Public License - v 1.0.
 * The full license text can be found in LICENSE.txt file and
 * on the Eclipse official site (https://www.eclipse.org/legal/epl-v10.html).
 */

'use strict';

/* eslint no-path-concat: "off" */

var common = require('./utils/common.js');
var Logger = require('./utils/logger.js');
var Actor = require('./actor.js');
var InMemoryActor = require('./in-memory-actor.js');
var ForkedActorParent = require('./forked-actor-parent.js');
var ForkedActorChild = require('./forked-actor-child.js');
var RemoteActorParent = require('./remote-actor-parent.js');
var RemoteActorChild = require('./remote-actor-child.js');
var RootActor = require('./root-actor.js');
var RoundRobinBalancerActor = require('./standard/round-robin-balancer-actor.js');
var MessageSocket = require('./net/message-socket.js');
var ForkedActorReferenceMarshaller = require('./marshallers/forked-actor-reference-marshaller.js');
var RemoteActorReferenceMarshaller = require('./marshallers/remote-actor-reference-marshaller.js');
var childProcess = require('child_process');
var appRootPath = require('app-root-path');
var requireDir = require('require-dir');
var toSource = require('tosource');
var bson = require('bson');
var P = require('bluebird');
var _ = require('underscore');
var s = require('underscore.string');
var randomString = require('randomstring');
var globalRequire = require;
var fs = require('fs');
var net = require('net');
var http = require('http');
var os = require('os');

P.promisifyAll(fs);

// Default actor system instance reference.
var defaultSystem;

// Default listening port for remote actor system.
const defaultListeningPort = 6161;

/**
 * An actor system.
 */
class ActorSystem {
  /**
   * @param {Object} [options] Actor system options.
   * - {Object} [log] Custom logger.
   * - {Boolean} [test] If true, sets this system into test mode.
   * - {Boolean} [debug] If true, sets this system into debug mode.
   * - {Boolean} [forceInMemory] If true, all actors will be launched in 'in-memory' mode.
   * - {Object} [root] Root actor behaviour.
   * - {Object} [rootParameters] Root actor custom parameters.
   * - {Object} [rootParametersMarshalledTypes] Value marshalling information for custom parameters.
   */
  constructor(options = {}) {
    this.debugPortCounter = 1;
    this.log = options.log || new Logger();
    this.options = _.clone(options);
    this.resourceDefPromises = {};
    this.resourceDefClassesPromise = this._loadResourceDefinitions(options.resources);
    this.marshallers = {};

    if (options.test) this.log.setLevel(this.log.levels().Silent); // Do not output anything in tests.

    if (options.debug) {
      this.log.setLevel(this.log.levels().Debug); // Overrides test option.

      try {
        P.longStackTraces();
      }
      catch (err) {
        this.log.warn('Failed to enable long stack traces: ' + err);
      }
    }

    var additionalRequires = this.options.additionalRequires;

    if (additionalRequires) {
      _.isArray(additionalRequires) || (additionalRequires = [additionalRequires]);

      _.each(additionalRequires, path => {
        require(path);
      });
    }

    if (options.root) {
      // Create root with custom behaviour.
      this.rootActorPromise = P.resolve()
        .then(() => {
          if (!options.rootParameters) return;

          if (!options.rootParametersMarshalledTypes) return options.rootParameters;

          return P.reduce(_.pairs(options.rootParametersMarshalledTypes), (memo, kv) => {
            var marshalledType = kv[1];

            if (marshalledType && marshalledType != 'SocketHandle') {
              var marshaller;

              if (marshalledType == 'InterProcessReference') {
                marshaller = this.getForkedActorReferenceMarshaller();
              }
              else if (marshalledType == 'InterHostReference') {
                marshaller = this.getRemoteActorReferenceMarshaller();
              }
              else {
                marshaller = this.marshallers[marshalledType];
              }

              if (!marshaller) throw new Error(`Don't know how to un-marshall custom parameter ${kv[0]}`);

              return marshaller.unmarshall(memo[kv[0]])
                .then(ref => {
                  memo[kv[0]] = ref;

                  return memo;
                });
            }

            return memo;
          }, _.clone(options.rootParameters));
        })
        .then(customParameters => this.createActor(options.root, null, {
          mode: 'in-memory',
          id: options.rootId,
          customParameters: customParameters
        }));

      if (options.parent && options.mode) {
        if (options.mode == 'forked') {
          // Create forked root with proper parent.
          this.rootActorPromise = this.rootActorPromise.then(rootActor => {
            return new ForkedActorChild({
              system: this,
              bus: process,
              actor: rootActor,
              definition: options.root,
              parentId: options.parent.id
            });
          });
        }
        else if (options.mode == 'remote') {
          // Create remote root with proper parent.
          this.rootActorPromise = this.rootActorPromise.then(rootActor => {
            return new RemoteActorChild({
              system: this,
              actor: rootActor,
              definition: options.root,
              parentId: options.parent.id
            });
          });
        }
        else {
          this.rootActorPromise = P.throw(new Error(`Unknown child system mode: ${options.mode}.`));
        }
      }
    }
    else {
      // Create default root.
      this.rootActorPromise = P.resolve(new RootActor(this, { forked: !!options.forked }));
    }

    // Initialize marshallers.
    if (options.marshallers) {
      this.rootActorPromise = this.rootActorPromise.tap(() => this._initializeMarshallers(options.marshallers));
    }

    this.rootActorPromise = this.rootActorPromise
      .tap(() => this._loadConfiguration(options.config))
      .tap(actor => actor.initialize());

    // Kill child process if self process is killed.
    this.sigintHandler = () => {
      this.log.info('Received SIGINT, exiting');

      process.exit(0);
    };
    this.sigtermHandler = () => {
      this.log.info('Received SIGTERM, exiting');

      process.exit(0);
    };
    process.once('SIGINT', this.sigintHandler);
    process.once('SIGTERM', this.sigtermHandler);
  }

  /**
   * @returns {*} Logger for this system.
   */
  getLog() {
    return this.log;
  }

  /**
   * Returns a marshaller for a given type name.
   *
   * @param {String} typeName Type name.
   * @returns {Object|undefined} Marshaller for a given message or undefined, if a marshaller for a given
   * message was not found.
   */
  getMarshaller(typeName) {
    return this.marshallers[typeName];
  }

  /**
   * Returns a marshaller for a given message.
   *
   * @param {*} message Message.
   * @returns {Object|undefined} Marshaller for a given message or undefined, if a marshaller for a given
   * message was not found.
   */
  getMarshallerForMessage(message) {
    return this.marshallers[this._typeName(message)];
  }

  /**
   * Returns a marshaller for sending actor reference to a forked actor.
   *
   * @returns {ForkedActorReferenceMarshaller} Marshaller instance.
   */
  getForkedActorReferenceMarshaller() {
    var ret = this.forkedActorReferenceMarshaller;

    if (!ret) {
      ret = this.forkedActorReferenceMarshaller = new ForkedActorReferenceMarshaller(this);
      ret.type = 'InterProcessReference';
    }

    return ret;
  }

  /**
   * Returns a marshaller for sending actor reference to a remote actor.
   *
   * @returns {RemoteActorReferenceMarshaller} Marshaller instance.
   */
  getRemoteActorReferenceMarshaller() {
    var ret = this.remoteActorReferenceMarshaller;

    if (!ret) {
      ret = this.remoteActorReferenceMarshaller = new RemoteActorReferenceMarshaller(this);
      ret.type = 'InterHostReference';
    }

    return ret;
  }

  /**
   * Returns actor ping timeout, defined for this system.
   *
   * @returns {Number} Ping timeout in milliseconds.
   */
  getPingTimeout() {
    return this.options.pingTimeout || 15000;
  }

  /**
   * @returns {P} Promise which yields root actor for this system.
   */
  rootActor() {
    return this.rootActorPromise;
  }

  /**
   * Creates an actor.
   *
   * @param {Object|String} Definition Actor definition object or module path.
   * @param {Actor} parent Actor parent.
   * @param {Object} [options] Actor creation options.
   * @returns {*} Promise that yields a created actor.
   */
  createActor(Definition, parent, options = {}) {
    return P.resolve()
      .then(() => {
        if (_.isString(Definition)) {
          // Module path is specified => load actor module.
          return this._loadDefinition(Definition);
        }

        return Definition;
      })
      .then(Definition0 => {
        var actorName = options.name || this._actorName(Definition0);

        // Determine actor configuration.
        if (this.config && actorName) {
          var actorConfig = this.config[actorName] || this.config[s.decapitalize(actorName)];

          options = _.extend({ mode: 'in-memory' }, actorConfig, options);
        }

        if (this.options.forceInMemory && options.mode != 'in-memory') {
          this.log.warn('Forcing in-memory mode due to forceInMemory flag for actor:', actorName);
          options = _.extend({}, options, { mode: 'in-memory' });
        }

        // Actor creation.
        switch (options.mode || 'in-memory') {
          case 'in-memory':
            return this._createInMemoryActor(Definition0, parent, _.defaults({ name: actorName }, options));

          case 'forked':
            return this._createForkedActor(Definition, parent, _.defaults({ name: actorName }, options));

          case 'remote':
            return this._createRemoteActor(Definition, parent, _.defaults({ name: actorName }, options));

          default:
            return P.resolve().throw(new Error('Unknown actor mode: ' + options.mode));
        }
      });
  }

  /**
   * Starts network port listening, allowing remote actor creation by other systems.
   *
   * @param {Number} [port] Listening port (default is 6161).
   * @param {String} [host] Listening host address (default is all addresses).
   * @returns {P} Promise, which is resolved once server is ready to accept requests or a
   * listening error has occurred.
   */
  listen(port = defaultListeningPort, host) {
    if (!this.serverPromise) {
      this.serverPromise = P.fromCallback(cb => {
        this.server = net.createServer();
        this.server.listen(port, host);

        this.server.on('listening', () => {
          this.log.info(`Listening on ${this.server.address().address}:${this.server.address().port}`);

          cb();
        });
        this.server.on('error', err => {
          this.log.error('Net server error: ' + err.message);

          cb(err);
        });
        this.server.on('connection', socket => {
          var msgSocket = new MessageSocket(socket);

          msgSocket.on('message', msg => {
            if (msg.type != 'create-actor') return;

            var psArgs = [];

            if (msg.body.name) {
              this.log.info(`Creating remote actor ${msg.body.name}`);
              psArgs.push(msg.body.name);
            }
            else {
              this.log.info('Creating remote actor (name unknown)');
            }

            var workerProcess = childProcess.fork(__dirname + '/forked-actor-worker.js', psArgs);

            workerProcess.send(msg, (err) => {
              if (err) return msgSocket.write({ error: 'Failed to create remote actor process: ' + err.message });

              // Redirect forked process response to parent actor.
              workerProcess.once('message', msg => {
                msgSocket.write(msg);
                msgSocket.end();

                // Close IPC channel to make worker process fully independent.
                workerProcess.disconnect();
                workerProcess.unref();
              });
            });

            // Handle forked process startup failure.
            workerProcess.once('error', err => {
              msgSocket.write({ error: 'Failed to create remote actor process: ' + err.message });
            });
          });
        });
      });
    }

    return this.serverPromise;
  }

  /**
   * Returns an IP address of this system's host, through which remote systems can
   * communicate with this one.
   *
   * @returns {String|undefined} Public IP address or undefined, if no such address exists.
   */
  getPublicIpAddress() {
    var ifaces = os.networkInterfaces();
    var result;

    _.some(ifaces, iface => {
      return _.some(iface, part => {
        if (part.internal === false && part.family == 'IPv4') {
          result = part.address;

          return true;
        }
      });
    });

    return result;
  }

  /**
   * Initializes message marshallers.
   *
   * @param {Array} marshallerDefs Marshaller definitions.
   * @returns {P} Initialization promise.
   * @private
   */
  _initializeMarshallers(marshallerDefs) {
    // Validate marshaller array.
    var marshallerTypes = _.countBy(marshallerDefs, marshallerDef => typeof marshallerDef);

    if (_.keys(marshallerTypes).length > 1) {
      return P.reject(new Error('Mixed types in marshallers configuration array are not allowed.'));
    }

    return P
      .reduce(marshallerDefs, (memo, marshallerDef) => {
        return P.resolve()
          .then(() => {
            if (_.isString(marshallerDef)) {
              return this._loadDefinition(marshallerDef);
            }

            return marshallerDef;
          })
          .then(marshallerDef => {
            if (_.isFunction(marshallerDef)) {
              return this._injectResources(marshallerDef);
            }
            else {
              return _.clone(marshallerDef);
            }
          })
          .then(marshallerInstance => {
            var types = this._readProperty(marshallerInstance, 'type');

            _.isArray(types) || (types = [types]);

            _.each(types, type => {
              var typeName = _.isString(type) ? type : this._typeName(type);

              if (!typeName) throw new Error('Failed to determine type name for marshaller: ' + marshallerInstance);

              marshallerInstance.type = typeName;
              memo[typeName] = marshallerInstance;
            });

            return memo;
          });
      }, {})
      .then(marshallers => {
        this.marshallers = marshallers;
      });
  }

  /**
   * Creates a process-local (in-memory) actor.
   *
   * @param {Object|Function} Definition Actor behaviour definition.
   * @param {Actor} parent Actor parent.
   * @param {Object} options Operation options.
   * - {String} name Actor name.
   * @returns {*} Promise that yields a newly-created actor.
   * @private
   */
  _createInMemoryActor(Definition, parent, options) {
    return P.resolve()
      .then(() => {
        if (_.isFunction(Definition)) {
          return this._injectResources(Definition);
        }

        return Definition;
      })
      .then(def => new InMemoryActor({
        system: this,
        parent: parent,
        definition: def,
        id: options.id,
        name: options.name,
        customParameters: options.customParameters
      }));
  }

  /**
   * Creates a forked actor.
   *
   * @param {Object|String} definition Actor behaviour definition or module path.
   * @param {Actor} parent Actor parent.
   * @param {Object} [options] Operation options.
   * @returns {P} Promise that yields a newly-created actor.
   * @private
   */
  _createForkedActor(definition, parent, options = {}) {
    // Perform clusterization, if needed.
    if (options.clusterSize > 1) {
      return P.resolve()
        .then(() => {
          var balancerActor = new RoundRobinBalancerActor({
            system: this,
            parent: parent,
            namePrefix: options.name,
            mode: options.mode
          });

          var childPromises = _.times(options.clusterSize, () =>
            balancerActor.createChild(definition, _.extend({}, options, { clusterSize: 1 })));

          return P.all(childPromises).return(balancerActor);
        });
    }

    return P.resolve(
      new ForkedActorParent({ system: this, parent: parent, definition: definition, additionalOptions: options }));
  }

  /**
   * Creates a remote actor.
   *
   * @param {Object|String} definition Actor behaviour definition or module path.
   * @param {Actor} parent Actor parent.
   * @param {Object} [options] Operation options.
   * @returns {P} Promise that yields a newly-created actor.
   * @private
   */
  _createRemoteActor(definition, parent, options) {
    return P.resolve().then(() => {
      var host = options.host;
      var cluster = options.cluster;
      var clusterDef;

      if (!host && !cluster)
        throw new Error('Neither "host" nor "cluster" option specified for "remote" mode.');

      if (cluster) {
        clusterDef = this.options.clusters[cluster];

        if (!clusterDef) throw new Error(`Cluster with name "${cluster}" is not defined.`);
      }
      else if (_.isArray(host)) {
        clusterDef = host;
      }
      else if (options.clusterSize > 1) {
        clusterDef = [host];
      }

      // Create clustered actor, if needed.
      if (clusterDef) {
        var balancerActor = new RoundRobinBalancerActor({
          system: this,
          parent: parent,
          namePrefix: options.name,
          mode: options.mode
        });
        var clusterSize = options.clusterSize || clusterDef.length;

        var childPromises = _.times(clusterSize, idx => {
          var hostPort = clusterDef[idx % clusterDef.length];
          var hostPort0 = hostPort.split(':');

          if (hostPort0.length > 1) {
            hostPort0[1] = parseInt(hostPort0[1]);
          }
          else {
            hostPort0.push(defaultListeningPort);
          }

          return balancerActor.createChild(
            definition,
            _.chain(options).omit('cluster').extend({ host: hostPort0[0], port: hostPort0[1], clusterSize: 1 }).value()
          );
        });

        return P.all(childPromises).return(balancerActor);
      }

      return new RemoteActorParent({
        system: this,
        parent: parent,
        definition: definition,
        pingChild: options.onCrash == 'respawn',
        additionalOptions: options
      });
    });
  }

  /**
   * Generates actor creation message.
   *
   * @param {Object|String} definition Actor behaviour definition or module path.
   * @param {Actor} actor Local endpoint actor.
   * @param {Object} options Operation options.
   * - {String} mode Actor mode ('forked' or 'remote').
   * - {String} [name] Actor name.
   * - {Object} [customParameters] Custom actor parameters.
   * @returns {Promise} Actor creation message promise.
   */
  generateActorCreationMessage(definition, actor, options) {
    var createMsg = {
      type: 'create-actor',
      body: {
        id: actor.getId(),
        definition: _.isString(definition) ? definition : this._serializeDefinition(definition),
        definitionFormat: _.isString(definition) ? 'modulePath' : 'serialized',
        config: this.config,
        resources: this.options.resources,
        test: this.options.test,
        debug: this.options.debug,
        parent: {
          id: actor.getParent().getId()
        },
        mode: options.mode,
        logLevel: this.log.getLevel(),
        additionalRequires: this.options.additionalRequires,
        customParameters: options.customParameters,
        pingTimeout: this.getPingTimeout(),
        clusters: this.options.clusters
      }
    };

    options.name && (createMsg.body.name = options.name);

    if (this.options.marshallers) {
      var marshallerFormat = 'modulePath';

      createMsg.body.marshallers = _.map(this.options.marshallers, marshaller => {
        if (!_.isString(marshaller)) {
          marshallerFormat = 'serialized';

          return this._serializeDefinition(marshaller);
        }
        else {
          return marshaller;
        }
      });
      createMsg.body.marshallerFormat = marshallerFormat;
    }

    if (this.options.resources && !_.isString(this.options.resources)) {
      var resourceFormat = [];

      createMsg.body.resources = _.map(this.options.resources, resourceDef => {
        if (!_.isString(resourceDef)) {
          resourceFormat.push('serialized');

          return this._serializeDefinition(resourceDef);
        }
        else {
          resourceFormat.push('modulePath');

          return resourceDef;
        }
      });
      createMsg.body.resourceFormat = resourceFormat;
    }

    return P.resolve()
      .then(() => {
        if (options.customParameters) {
          var customParametersMarshalledTypes = {};

          return P
            .reduce(_.pairs(options.customParameters), (memo, kv) => {
              var key = kv[0];
              var value = kv[1];

              if (value instanceof Actor) {
                var marshaller = this.getForkedActorReferenceMarshaller();

                return marshaller.marshall(value)
                  .then(marshalledValue => {
                    memo[key] = marshalledValue;
                    customParametersMarshalledTypes[key] = 'InterProcessReference';
                  })
                  .return(memo);
              }
              else if (value instanceof http.Server || value instanceof net.Server) {
                if (createMsg.socketHandle) throw new Error('Only one socket handle is allowed in custom parameters.');

                createMsg.socketHandle = value;
                customParametersMarshalledTypes[key] = 'SocketHandle';

                memo[key] = value instanceof http.Server ? 'http.Server' : 'net.Server';
              }
              else {
                memo[key] = value;
              }

              return memo;
            }, {})
            .then(customParameters => {
              createMsg.body.customParameters = customParameters;

              if (!_.isEmpty(customParametersMarshalledTypes)) {
                createMsg.body.customParametersMarshalledTypes = customParametersMarshalledTypes;
              }
            });
        }
      })
      .return(createMsg);
  }

  /**
   * Generates a new ID for an actor.
   *
   * @returns {String} New actor ID.
   */
  generateActorId() {
    return new bson.ObjectID().toString();
  }

  /**
   * Helper function to correctly import modules in different processes with
   * different directory layout. If a module path ends with /, imports the whole
   * directory.
   *
   * @param {String} modulePath Path of the module to import. If starts with /, a module
   * is searched relative to project directory.
   * @returns {*} Module import result.
   */
  require(modulePath) {
    if (modulePath[0] != '/' && modulePath[0] != '.') {
      return globalRequire(modulePath);
    }
    else if (_.last(modulePath) == '/') {
      return this.requireDirectory(modulePath);
    }
    else {
      return globalRequire(appRootPath + modulePath);
    }
  }

  /**
   * Imports all modules from a given directory.
   *
   * @param {String} path Directory path. If starts with /, the path will be relative to a
   * project directory (the one with package.json file).
   * @returns {Object} Module file name -> loaded module map object.
   */
  requireDirectory(path) {
    var path0 = path;

    if (path0[0] == '/') {
      path0 = appRootPath + path0;
    }

    return requireDir(path0);
  }

  /**
   * Destroys this system. All actors will be destroyed and all destroy hooks will be called.
   *
   * @returns {P} Operation promise.
   */
  destroy() {
    if (this.destroying) return this.destroyPromise;

    this.destroying = true;

    process.removeListener('SIGINT', this.sigintHandler);
    process.removeListener('SIGTERM', this.sigtermHandler);

    this.destroyPromise = this.rootActorPromise
      .then(rootActor => rootActor.destroy())
      // Destroy marshallers.
      .then(() => {
        if (this.forkedActorReferenceMarshaller) {
          return this.forkedActorReferenceMarshaller.destroy();
        }
      })
      .then(() => {
        if (this.remoteActorReferenceMarshaller) {
          return this.remoteActorReferenceMarshaller.destroy();
        }
      })
      // Destroy system resources.
      .then(() => {
        return P.map(_.values(this.resourceDefPromises), resource => {
          if (resource && _.isFunction(resource.destroy)) {
            return resource.destroy();
          }
        });
      })
      .then(() => {
        if (this.server) {
          this.server.close();
        }
      })
      .finally(() => {
        if (this.options.mode == 'forked' || this.options.mode == 'remote') {
          this.log.info('Killing forked system process.');

          process.exit();
        }
      });

    return this.destroyPromise;
  }

  /**
   * Loads actor resource definitions.
   *
   * @param {Function[]|String[]|String} resources Array of resource classes or module paths, or a
   * path to a directory with resource modules.
   * @returns {P} Resource definition array promise.
   * @private
   */
  _loadResourceDefinitions(resources) {
    if (!resources) return P.resolve([]);

    if (_.isArray(resources)) {
      return P.map(resources, resource => {
        if (_.isString(resource)) return this._loadDefinition(resource);

        return resource;
      });
    }
    else if (_.isString(resources)) {
      return P.resolve(_.map(this.requireDirectory(resources), module => module.default || module));
    }
    else {
      return P.reject(new Error('Illegal value for "resources" option.'));
    }
  }

  /**
   * Loads actor behaviour definition from a given module.
   *
   * @param {String} path Actor behaviour module path.
   * @returns {P} Operation promise, which yields an actor behaviour.
   * @private
   */
  _loadDefinition(path) {
    return P.resolve().then(() => {
      var ret = this.require(path);

      // TypeScript default export support.
      if (ret.default) {
        ret = ret.default;
      }

      return ret;
    });
  }

  /**
   * Determines a given definition name.
   *
   * @param {Object|Function} Definition Behaviour definition.
   * @param {String} nameField Name of an additional field to use for name resolution.
   * @returns {String} Definition name or empty string, if name is not defined.
   * @private
   */
  _definitionName(Definition, nameField) {
    // Use 'getName' getter, if present.
    if (_.isFunction(Definition.getName)) return Definition.getName();

    // Take 'actorName' field, if present.
    if (Definition.actorName) return _.result(Definition, nameField);

    // Take 'name' field, if present.
    if (Definition.name) return _.result(Definition, 'name');

    // Use class name, if present.
    var typeName = this._typeName(Definition);

    if (typeName) return typeName;

    if (_.isFunction(Definition)) {
      return this._actorName(new Definition());
    }

    return '';
  }

  /**
   * Determines actor name based on actor definition.
   *
   * @param {Object|Function} Definition Actor behaviour definition.
   * @returns {String} Actor name or empty string, if actor name is not defined.
   * @private
   */
  _actorName(Definition) {
    return this._definitionName(Definition, 'actorName');
  }

  /**
   * Determines resource name based on resource definition.
   *
   * @param {Object|Function} Definition Resource definition.
   * @returns {String} Resource name or empty string, if name is not defined.
   * @private
   */
  _resourceName(Definition) {
    return this._definitionName(Definition, 'resourceName');
  }

  /**
   * Attempts to determine a name of a given type.
   *
   * @param {*} type Type of interest.
   * @returns {String|undefined} Type name or undefined, if type name cannot be determined.
   * @private
   */
  _typeName(type) {
    if (!type) return;

    if (_.isFunction(type)) {
      return type.typeName || type.name;
    }

    if (type.constructor) {
      return _.result(type.constructor, 'typeName') || type.constructor.name;
    }
  }

  /**
   * Performs actor definition resource injection.
   *
   * @param {Function} Definition Definition class.
   * @returns {P} Promise of definition instance with injected resources.
   * @private
   */
  _injectResources(Definition) {
    var resourceNames = _.result(Definition, 'inject');

    if (resourceNames && !_.isArray(resourceNames)) {
      resourceNames = [resourceNames];
    }

    // Resource injection.
    if (resourceNames && _.isFunction(Definition)) {
      return P
        .map(resourceNames, resourceName => {
          return this._initializeResource(resourceName)
            .then(resourceDef => resourceDef && resourceDef.getResource())
            .tap(resource => {
              if (!resource) {
                throw new Error(`Failed to inject resource "${resourceName}" to actor definition ${Definition}`);
              }
            });
        })
        // Create an instance of actor definition, passing resources as constructor arguments.
        .then(resources => new Definition(...resources));
    }

    return P.resolve(new Definition());
  }

  /**
   * Initializes resource with a given name. An existing resource is returned, if already initialized.
   *
   * @param {String} resourceName Resource name.
   * @param {String[]} [depPath] Resource dependency path for detecting cyclic dependencies.
   * @returns {Promise} Initialized resource definition instance promise. Resolves to undefined,
   * if resource with given name is not found.
   * @private
   */
  _initializeResource(resourceName, depPath) {
    if (this.resourceDefPromises[resourceName]) return this.resourceDefPromises[resourceName];

    depPath = depPath || [resourceName];

    var resourceDefPromise = this.resourceDefClassesPromise
      .then(resourceDefClasses => {
        // Attempt to find a resource definition class.
        var ResourceDefCls = _.find(resourceDefClasses, ResourceDefCls => {
          var resourceName0 = this._resourceName(ResourceDefCls);

          return resourceName0 == resourceName;
        });

        if (ResourceDefCls) {
          var depsPromise = P.resolve([]);

          if (_.isFunction(ResourceDefCls.inject)) {
            depsPromise = P.map(
              ResourceDefCls.inject(),
              resourceDep => {
                var newDepPath = depPath.concat(resourceDep);

                if (_.contains(depPath, resourceDep))
                  throw new Error('Cyclic resource dependency: ' + newDepPath.join('->'));

                return this._initializeResource(resourceDep, newDepPath).then(resourceDef => {
                  if (!resourceDef) throw new Error(`Resource with name ${resourceDep} not found.`);

                  return resourceDef.getResource();
                });
              });
          }

          return depsPromise.then(deps => {
            var resourceInstance = ResourceDefCls;

            if (!common.isPlainObject(ResourceDefCls)) {
              resourceInstance = new ResourceDefCls(...deps);
            }

            if (_.isFunction(resourceInstance.initialize)) {
              return P.resolve(resourceInstance)
                .tap(() => resourceInstance.initialize(this));
            }
            else {
              return resourceInstance;
            }
          });
        }
      });

    this.resourceDefPromises[resourceName] = resourceDefPromise;

    return resourceDefPromise;
  }

  /**
   * Reads a given property from an object. Attempts to read either directly by name or by getter (if present).
   *
   * @param {Object} object Object of interest.
   * @param {String} propName Property name.
   * @returns {*} Property value or undefined.
   * @private
   */
  _readProperty(object, propName) {
    var ret = object[propName];

    if (!ret) {
      var getterName = `get${s.capitalize(propName)}`;

      if (_.isFunction(object[getterName])) {
        ret = object[getterName]();
      }
    }

    return ret;
  }

  /**
   * Serializes a given actor behaviour definition for transferring to other process.
   *
   * @param {Object|Function|Array} def Actor behaviour definition.
   * @returns {String} Serialized actor behaviour.
   * @private
   */
  _serializeDefinition(def) {
    if (_.isArray(def)) {
      return toSource(_.map(def, item => this._serializeDefinition(item)));
    }

    if (common.isPlainObject(def)) return toSource(def);

    if (_.isFunction(def)) { // Class-defined behaviour.
      return this._serializeClassDefinition(def);
    }

    throw new Error('Cannot serialize actor definition: ' + def);
  }

  /**
   * Serializes a given class-defined actor behaviour.
   *
   * @param {Function} def Class-defined actor behaviour.
   * @returns {String} Serialized actor behaviour.
   * @private
   */
  _serializeClassDefinition(def) {
    // Get a base class for behaviour class.
    var base = Object.getPrototypeOf(def);
    var baseBehaviour = '';

    if (base && base.name) {
      // Have a user-defined super class. Serialize it as well.
      baseBehaviour = this._serializeClassDefinition(base);
    }

    var selfString = def.toString();

    if (s.startsWith(selfString, 'function')) {
      selfString = this._serializeEs5ClassDefinition(def, selfString, base.name);
    }
    else if (s.startsWith(selfString, 'class')) {
      selfString += '; ' + def.name + ';';
    }

    return baseBehaviour + selfString;
  }

  /**
   * Serializes a given ES5 class actor behaviour definition.
   *
   * @param {Function} def Actor behaviour definition in ES5 class form.
   * @param {String} [selfString] Stringified class head.
   * @param {String} [baseName] Base class name.
   * @returns {String} Serialized actor behaviour.
   * @private
   */
  _serializeEs5ClassDefinition(def, selfString, baseName) {
    var clsName = this._actorName(def);

    if (!clsName) {
      clsName = randomString.generate({
        length: 12,
        charset: 'alphabetic'
      });
    }

    var expressions = [`var ${clsName} = ${selfString || def.toString()};\n`];

    if (baseName) {
      expressions.push(`_inherits(${clsName}, ${baseName});`);
    }

    var staticMemberNames = Object.getOwnPropertyNames(def);

    _.each(staticMemberNames, memberName => {
      if (memberName != 'length' && memberName != 'prototype' && memberName != 'name') {
        expressions.push(`${clsName}.${memberName} = ${def[memberName].toString()};\n`);
      }
    });

    var membersNames = Object.getOwnPropertyNames(def.prototype);

    _.each(membersNames, memberName => {
      if (memberName != 'constructor') {
        expressions.push(`${clsName}.prototype.${memberName} = ${def.prototype[memberName].toString()};\n`);
      }
    });

    expressions.push(`${clsName};`);

    return expressions.join('');
  }

  /**
   * Generates a lightweight proxy object for this system to expose only
   * specific methods to a client.
   *
   * @returns {Object} Proxy object.
   * @private
   */
  _selfProxy() {
    return {
      require: this.require.bind(this),
      getLog: this.getLog.bind(this)
    };
  }

  /**
   * Loads actor configuration.
   *
   * @param {Object|String} config Actor configuration object or file path.
   * @returns {P} Operation promise.
   * @private
   */
  _loadConfiguration(config) {
    if (_.isObject(config)) {
      this.config = config;

      this.options.mode || this.log.info('Using programmatic actor configuration.');

      return P.resolve();
    }

    // Do not load configuration from file in test mode.
    if (this.options.test) return P.resolve();

    this.config = {};

    var defaultPath = appRootPath + '/actors.json';

    return fs.readFileAsync(defaultPath)
      .then(data => {
        this.log.info('Loaded default actor configuration file: ' + defaultPath);

        this.config = JSON.parse(data);
      })
      .catch(() => {
        this.log.info(
          'Didn\'t find (or couldn\'t load) default configuration file ' + defaultPath + '.');
      })
      .then(() => {
        if (!_.isString(config)) return;

        // Config path specified => read custom configuration and extend default one.
        return fs.readFileAsync(config)
          .then(data => {
            this.log.info('Loaded external actor configuration file: ' + config);

            if (!_.isEmpty(this.config)) {
              this.log.info('Extending default actor configuration (' + defaultPath +
                ') with external actor configuration (' + config + ')');
            }

            this.config = _.extend(this.config, JSON.parse(data));
          })
          .catch(() => {
            this.log.info(
              'Didn\'t find (or couldn\'t load) external actor configuration file ' + config +
              ', leaving default configuration.');
          });
      })
      .then(() => {
        this.log.info('Resulting actor configuration: ' + JSON.stringify(this.config, null, 2));
      });
  }

  /**
   * @returns {ActorSystem} Default actor system.
   */
  static default() {
    if (defaultSystem) {
      defaultSystem = new ActorSystem();
    }

    return defaultSystem;
  }

  /**
   * A recommended function for ES5 class inheritance. If this function is used for inheritance,
   * the actors are guaranteed to be successfully transferred to forked/remote nodes.
   *
   * @param {Function} subClass Sub class.
   * @param {Function} superClass Super class.
   */
  static inherits(subClass, superClass) {
    subClass.prototype = Object.create(superClass && superClass.prototype, {
      constructor: {
        value: subClass,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });

    Object.setPrototypeOf(subClass, superClass);
  }
}

module.exports = ActorSystem;