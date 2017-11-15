/*
 * Copyright (c) 2016-2017 Untu, Inc.
 * This code is licensed under Eclipse Public License - v 1.0.
 * The full license text can be found in LICENSE.txt file and
 * on the Eclipse official site (https://www.eclipse.org/legal/epl-v10.html).
 */

'use strict';

/**
 * Proxy, returned for forked actor parent. Limits the functionality
 * of forked actor reference.
 */
class ForkedActorProxy {
  /**
   * @param {Actor} actor Wrapped actor.
   */
  constructor(actor) {
    this.setWrapped(actor);
  }

  /**
   * Initializes the actor.
   */
  initialize() {
    this.actor.initialize();
  }

  /**
   * Sets a new wrapped actor for this stub.
   *
   * @param {Actor} actor Wrapped actor.
   */
  setWrapped(actor) {
    this.actor = actor;
  }

  /**
   * @returns {Actor} Wrapped actor for this stub.
   */
  getWrapped() {
    return this.actor;
  }

  /**
   * Synchronously returns this actor's ID.
   *
   * @returns {String} This actor ID.
   */
  getId() {
    return this.actor.getId();
  }

  /**
   * Synchronously returns this actor's name.
   *
   * @returns {String} This actor's name or empty string, if there is no name for this actor.
   */
  getName() {
    return this.actor.getName();
  }

  /**
   * Synchronously returns this actor's logger.
   *
   * @returns {Logger|ActorLogger} Actor logger.
   */
  getLog() {
    return this.actor.getLog();
  }

  /**
   * Synchronously returns this actor's mode.
   *
   * @returns {String} Actor mode.
   */
  getMode() {
    return this.actor.getMode();
  }

  /**
   * Sends a message to actor. See Actor.send().
   *
   * @param {*} args Stubbed arguments.
   * @returns {P} Operation promise.
   */
  send(...args) {
    return this.actor.send(...args);
  }

  /**
   * Sends a message to actor and waits for response. See Actor.sendAndReceive().
   *
   * @param {*} args Stubbed arguments.
   * @returns {P} Operation promise, that yields actor response.
   */
  sendAndReceive(...args) {
    return this.actor.sendAndReceive(...args);
  }

  /**
   * Outputs actor tree for this actor.
   *
   * @returns {P} Operation promise that yields actor tree data object.
   */
  tree() {
    return this.actor.tree();
  }

  /**
   * Returns metrics for this actor.
   *
   * @returns {P} Operation promise that yields actor metrics.
   */
  metrics() {
    return this.actor.metrics();
  }

  /**
   * Destroys this actor.
   *
   * @returns {P} Operation promise.
   */
  destroy() {
    return this.actor.destroy();
  }

  /**
   * Subscribes to actor events.
   */
  once() {
    this.actor.on.apply(this.actor, arguments);
  }

  toString() {
    return this.actor.toString();
  }
}

module.exports = ForkedActorProxy;