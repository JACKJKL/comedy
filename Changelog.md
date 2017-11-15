### v 1.2.4:
- Fixed message routing to crashed actors.

### v 1.2.3:
- Moved ts-node and TypeScript to dev dependencies.

### v 1.2.2:
- Fixed TypeScript resource directory loading.

### v 1.2.1:
- Independent logging for each actor.
- Adjusted TypeScript typings.

### v 1.2.0:
- Added `Actor.getMode()` method.
- Added `Actor.broadcast()` and `Actor.broadcastAndReceive()` methods.
- Fixed premature parent ping in forked actor.
- Added possibility to forward all unknown topics to parent.

### v 1.1.3:
- Fixed wrong cluster distribution in `"remote"` mode.

### v 1.1.2:
- Added multiple host support in `"host"` parameter for remote actors.
- Fixed Node.JS 8.3.0 compatibility bug.
- Fixed unconditional remote actor pinging bug.

### v 1.1.1:
- Added clusterSize parameter support for remote actors using cluster parameter.

### v 1.1.0:
- Fixed metrics on dead actors.
- Removed context support in favour of resources.
- Implemented actor references.

### v 1.0.0:
- Added remote actor support.

### v 0.2.1:
- Added net.Server and http.Server marshalling support.
- Fixed 'channel closed' errors on second and subsequent respawns.

### v 0.2.0:
- Separate resource definitions support.
- Bug fixes.

### v 0.1.0:
- Added support for custom actor parameters.

### v 0.0.3:
- Bug fixes.

### v 0.0.2:
- Added `additionalRequires` actor system option, which allows requiring additional
modules in forked process.
- Added module-based marshaller support.
- Added `Actor.forwardToChild()` method.
- Fixed variable argument messages for forked mode.
- Added `Actor.metrics()` method and the metrics facility.

### v 0.0.1:
- Initial import from SAYMON project with some necessary corrections.