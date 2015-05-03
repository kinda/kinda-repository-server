"use strict";

var _ = require('lodash');
var parseBody = require('co-body');
var KindaObject = require('kinda-object');
var util = require('kinda-util').create();

// TODO: authorize handler, custom methods and event listeners should inherit from super classes

var KindaRepositoryServer = KindaObject.extend('KindaRepositoryServer', function() {
  // Options:
  //   signInWithCredentialsHandler:
  //     function *(credentials) {
  //       if (!credentials) return;
  //       if (credentials.username !== 'user@domain.com') return;
  //       if (credentials.password !== 'password') return;
  //       return 'secret-token';
  //     }
  //   signInWithAuthorizationHandler:
  //     function *(authorization) {
  //       return authorization === 'secret-token';
  //     },
  //   signOutHandler:
  //     function *(authorization) {
  //       // delete authorization token...
  //     },
  //   authorizeHandler:
  //     function *(request) {
  //       return request.authorization === 'secret-token';
  //     }
  this.setCreator(function(repository, clientRepository, options) {
    if (!options) options = {};
    this.repository = repository;
    this.clientRepository = clientRepository;
    _.assign(this, _.pick(options, [
      'signInWithCredentialsHandler',
      'signInWithAuthorizationHandler',
      'signOutHandler',
      'authorizeHandler'
    ]));
    this.registeredCollections = {};
    var collectionOptions = options.collections || {};
    _.forOwn(clientRepository.collectionClasses, function(klass, name) {
      if (!repository.collectionClasses[name]) {
        throw new Error('collection \'' + name + '\' is undefined in the server repository');
      }
      this.registerCollection(name, collectionOptions[name]);
    }, this);
  });

  this.registerCollection = function(name, options) {
    if (!options) options = {};
    var slug = _.kebabCase(name);
    var collection = KindaObject.create();
    collection.name = name;
    collection.slug = slug
    collection.authorizeHandler = options.authorizeHandler;
    collection.collectionMethods = options.collectionMethods || {};
    collection.itemMethods = options.itemMethods || {};
    _.forOwn(options.eventListeners, function(fn, event) {
      collection.onAsync(event, fn);
    });
    this.registeredCollections[slug] = collection;
  };

  this.handleRequest = function *(ctx, path, next) {
    var query = util.decodeObject(ctx.query);
    ctx.options = query;
    ctx.authorization = this.authorizationUnserializer({ query: query });

    var slug = path;
    if (_.startsWith(slug, '/')) slug = slug.slice(1);
    var index = slug.indexOf('/');
    if (index !== -1) {
      path = slug.slice(index);
      slug = slug.slice(0, index);
    } else {
      path = '';
    }

    if (slug === 'get-repository-id') {
      yield this.handleGetRepositoryIdRequest(ctx);
      return;
    }

    if (slug === 'authorizations') {
      yield this.handleAuthorizationRequest(ctx, path, next);
      return;
    }

    var registeredCollection = this.registeredCollections[slug];
    if (registeredCollection) {
      yield this.handleCollectionRequest(ctx, registeredCollection, path, next);
      return;
    }

    yield next;
  };

  this.readBody = function *(ctx) {
    ctx.request.body = yield parseBody.json(ctx, { limit: '8mb' });
  };

  this.authorizationUnserializer = function(obj) { // can be overridden
    return obj.query && obj.query.authorization;
  };

  this.authorizeRequest = function *(ctx, method, request) {
    if (!request) request = {};
    var handler;
    if (ctx.registeredCollection) {
      handler = ctx.registeredCollection.authorizeHandler;
    }
    if (!handler) handler = this.authorizeHandler;
    if (!handler) return;
    request.authorization = ctx.authorization;
    request.collection = ctx.collection;
    request.clientCollection = ctx.clientCollection;
    request.method = method;
    request.options = ctx.options;
    var isAuthorized = yield handler(request);
    if (!isAuthorized) ctx.throw(403, 'authorization failed');
  };

  this.emitEvent = function *(ctx, event, request) {
    if (!request) request = {};
    request.collection = ctx.collection;
    request.clientCollection = ctx.clientCollection;
    request.event = event;
    request.options = ctx.options;
    yield ctx.registeredCollection.emitAsync(event, request);
  };

  // === Repository requests ===

  this.handleGetRepositoryIdRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'getRepositoryId');
    var id = yield this.repository.getRepositoryId();
    ctx.type = 'application/json';
    ctx.body = JSON.stringify(id);
  };

  // === Authorization requests ===

  this.handleAuthorizationRequest = function *(ctx, path, next) {
    var fragment = path;
    if (_.startsWith(fragment, '/')) fragment = fragment.slice(1);
    var index = fragment.indexOf('/');
    if (index !== -1) {
      path = fragment.slice(index + 1);
      fragment = fragment.slice(0, index);
    } else {
      path = '';
    }
    var method = ctx.method;
    if (method === 'POST' && !fragment && !path) {
      yield this.handleSignInWithCredentialsRequest(ctx);
    } else if (method === 'GET' && fragment && !path) {
      yield this.handleSignInWithAuthorizationRequest(ctx, fragment);
    } else if (method === 'DELETE' && fragment && !path) {
      yield this.handleSignOutRequest(ctx, fragment);
    } else {
      yield next;
    }
  };

  this.handleSignInWithCredentialsRequest = function *(ctx) {
    yield this.readBody(ctx);
    var handler = this.signInWithCredentialsHandler;
    if (!handler) throw new Error('signInWithCredentialsHandler is undefined');
    var authorization = yield handler(ctx.request.body);
    if (!authorization) ctx.throw(403, 'sign in with credentials failed');
    ctx.status = 201;
    ctx.body = authorization;
  };

  this.handleSignInWithAuthorizationRequest = function *(ctx, authorization) {
    var handler = this.signInWithAuthorizationHandler;
    if (!handler) throw new Error('signInWithAuthorizationHandler is undefined');
    var isOkay = yield handler(authorization);
    if (!isOkay) ctx.throw(403, 'sign in with authorization failed');
    ctx.status = 204;
  };

  this.handleSignOutRequest = function *(ctx, authorization) {
    var handler = this.signOutHandler;
    if (!handler) throw new Error('signOutHandler is undefined');
    yield handler(authorization);
    ctx.status = 204;
  };

  // === Collection requests ===

  this.handleCollectionRequest = function *(ctx, registeredCollection, path, next) {
    var name = registeredCollection.name;
    ctx.registeredCollection = registeredCollection;
    ctx.collection = this.repository.createCollection(name);
    ctx.collection.context = this;
    ctx.clientCollection = this.clientRepository.createCollection(name);
    ctx.clientCollection.context = this;

    var fragment1 = path;
    var fragment2 = '';
    if (_.startsWith(fragment1, '/')) fragment1 = fragment1.slice(1);
    var index = fragment1.indexOf('/');
    if (index !== -1) {
      fragment2 = fragment1.slice(index + 1);
      fragment1 = fragment1.slice(0, index);
    }
    var camelCasedFragment1 = _.camelCase(fragment1);
    var camelCasedFragment2 = _.camelCase(fragment2);

    var method = ctx.method;
    if (method === 'POST' && fragment1 === 'get-items' && !fragment2) {
      yield this.handleGetItemsRequest(ctx);
    } else if (method === 'GET' && fragment1 === 'count' && !fragment2) {
      yield this.handleCountItemsRequest(ctx);
    } else if ((method === 'GET' || method === 'POST') && (ctx.registeredCollection.collectionMethods.hasOwnProperty(camelCasedFragment1)) && !fragment2) {
      yield this.handleCustomCollectionMethodRequest(ctx, camelCasedFragment1);
    } else if ((method === 'GET' || method === 'POST') && fragment1 && (ctx.registeredCollection.itemMethods.hasOwnProperty(camelCasedFragment2))) {
      yield this.handleCustomItemMethodRequest(ctx, fragment1, camelCasedFragment2);
    } else if (method === 'GET' && fragment1 && !fragment2) {
      yield this.handleGetItemRequest(ctx, fragment1);
    } else if (method === 'POST' && !fragment1 && !fragment2) {
      yield this.handlePostItemRequest(ctx);
    } else if (method === 'PUT' && fragment1 && !fragment2) {
      yield this.handlePutItemRequest(ctx, fragment1);
    } else if (method === 'DELETE' && fragment1 && !fragment2) {
      yield this.handleDeleteItemRequest(ctx, fragment1);
    } else if (method === 'GET' && !fragment1 && !fragment2) {
      yield this.handleFindItemsRequest(ctx);
    } else if (method === 'DELETE' && !fragment1 && !fragment2) {
      yield this.handleFindAndDeleteItemsRequest(ctx);
    } else {
      yield next;
    }
  };

  this._getItem = function *(ctx, id) {
    if (!id) ctx.throw(400, 'id required');
    var item = yield ctx.collection.getItem(id, { errorIfMissing: false });
    if (!item) {
      var errorIfMissing = ctx.options.errorIfMissing;
      if (errorIfMissing == null) errorIfMissing = true;
      if (errorIfMissing) ctx.throw(404, 'item not found');
    }
    return item;
  };

  this.handleGetItemRequest = function *(ctx, id) {
    var item = yield this._getItem(ctx, id);
    yield this.authorizeRequest(ctx, 'getItem', { item: item });
    var clientItem;
    if (item) {
      var className = item.getClassName();
      var clientCollection = this.clientRepository.createCollectionFromItemClassName(className);
      var clientItem = clientCollection.unserializeItem(item);
    }
    yield this.emitEvent(ctx, 'didGetItem', {
      clientItem: clientItem, item: item
    });
    if (clientItem) {
      ctx.body = {
        class: clientItem.getClassName(),
        value: clientItem.serialize()
      };
    } else {
      ctx.status = 204;
    }
  };

  this.handlePostItemRequest = function *(ctx) {
    yield this.readBody(ctx);
    var clientItem = ctx.clientCollection.unserializeItem(ctx.request.body);
    yield ctx.collection.transaction(function *() {
      var item = ctx.collection.createItem(clientItem);
      yield this.authorizeRequest(ctx, 'putItem', {
        clientItem: clientItem, item: item
      });
      yield this.emitEvent(ctx, 'willPutItem', {
        clientItem: clientItem, item: item
      });
      yield item.save();
      clientItem = ctx.clientCollection.unserializeItem(item);
      yield this.emitEvent(ctx, 'didPutItem', {
        clientItem: clientItem, item: item
      });
      ctx.status = 201;
      ctx.body = {
        class: clientItem.getClassName(),
        value: clientItem.serialize()
      };
    }.bind(this));
  };

  this.handlePutItemRequest = function *(ctx, id) {
    yield this.readBody(ctx);
    var clientItem = ctx.clientCollection.unserializeItem(ctx.request.body);
    yield ctx.collection.transaction(function *() {
      var item = yield this._getItem(ctx, id);
      yield this.authorizeRequest(ctx, 'putItem', {
        clientItem: clientItem, item: item
      });
      item.updateValue(clientItem);
      yield this.emitEvent(ctx, 'willPutItem', {
        clientItem: clientItem, item: item
      });
      yield item.save();
      clientItem = ctx.clientCollection.unserializeItem(item);
      yield this.emitEvent(ctx, 'didPutItem', {
        clientItem: clientItem, item: item
      });
      ctx.status = 200;
      ctx.body = {
        class: clientItem.getClassName(),
        value: clientItem.serialize()
      };
    }.bind(this));
  };

  this.handleDeleteItemRequest = function *(ctx, id) {
    var item = yield this._getItem(ctx, id);
    if (item) {
      yield this.authorizeRequest(ctx, 'deleteItem', { item: item });
      yield this.emitEvent(ctx, 'willDeleteItem', { item: item });
      yield item.delete();
      yield this.emitEvent(ctx, 'didDeleteItem', { item: item });
    }
    ctx.status = 204;
  };

  this.handleGetItemsRequest = function *(ctx) {
    yield this.readBody(ctx);
    yield this.authorizeRequest(ctx, 'getItems');
    var items = yield ctx.collection.getItems(ctx.request.body, ctx.options);
    var cache = {};
    var clientItems = items.map(function(item) {
      var className = item.getClassName();
      var clientCollection = this.clientRepository.createCollectionFromItemClassName(className, cache);
      return clientCollection.unserializeItem(item);
    }, this);
    yield this.emitEvent(ctx, 'didGetItems', {
      clientItems: clientItems, items: items
    });
    ctx.status = 201;
    ctx.body = _.map(clientItems, function(clientItem) {
      return {
        class: clientItem.getClassName(),
        value: clientItem.serialize()
      };
    });
  };

  this.handleFindItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'findItems');
    var items = yield ctx.collection.findItems(ctx.options);
    var cache = {};
    var clientItems = items.map(function(item) {
      var className = item.getClassName();
      var clientCollection = this.clientRepository.createCollectionFromItemClassName(className, cache);
      return clientCollection.unserializeItem(item);
    }, this);
    yield this.emitEvent(ctx, 'didFindItems', {
      clientItems: clientItems, items: items
    });
    ctx.status = 200;
    ctx.body = _.map(clientItems, function(clientItem) {
      return {
        class: clientItem.getClassName(),
        value: clientItem.serialize()
      };
    });
  };

  this.handleCountItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'countItems');
    var count = yield ctx.collection.countItems(ctx.options);
    yield this.emitEvent(ctx, 'didCountItems', {
      count: count
    });
    ctx.status = 200;
    ctx.body = count;
  };

  this.handleFindAndDeleteItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'findAndDeleteItems');
    yield ctx.collection.findAndDeleteItems(ctx.options);
    yield this.emitEvent(ctx, 'didFindAndDeleteItems');
    ctx.status = 204;
  };

  this.handleCustomCollectionMethodRequest = function *(ctx, method) {
    if (ctx.method === 'POST') yield this.readBody(ctx);
    yield this.authorizeRequest(ctx, method);
    var fn = ctx.registeredCollection.collectionMethods[method];
    if (fn === true) {
      fn = function *(request) {
        return {
          body: yield request.collection[method](request.options)
        }
      };
    }
    var result = yield this._callCustomMethod(ctx, fn);
    this._writeCustomMethodResult(ctx, result);
  };

  this.handleCustomItemMethodRequest = function *(ctx, id, method) {
    if (ctx.method === 'POST') yield this.readBody(ctx);
    var item = yield this._getItem(ctx, id);
    yield this.authorizeRequest(ctx, method, { item: item });
    var fn = ctx.registeredCollection.itemMethods[method];
    if (fn === true) {
      fn = function *(request) {
        return {
          body: yield request.item[method](request.options)
        }
      };
    }
    var result = yield this._callCustomMethod(ctx, fn, { item: item });
    this._writeCustomMethodResult(ctx, result);
  };

  this._callCustomMethod = function *(ctx, fn, request) {
    if (!request) request = {};
    request.collection = ctx.collection;
    request.clientCollection = ctx.clientCollection;
    request.options = ctx.options;
    request.body = ctx.request.body;
    return yield fn.call(this, request);
  };

  this._writeCustomMethodResult = function(ctx, result) {
    if (result.body == null) {
      ctx.status = 204;
      return;
    }
    ctx.status = ctx.method === 'POST' ? 201 : 200;
    _.forOwn(result.headers, function(value, key) {
      key = _.kebabCase(key);
      ctx.response.set(key, value);
    });
    ctx.body = result.body;
  };

  this.getMiddleware = function(prefix) {
    if (!prefix) prefix = '';
    if (_.endsWith(prefix, '/')) prefix = prefix.slice(0, -1);
    var that = this;
    return function *(next) {
      var path = this.path;
      if (prefix) {
        if (!_.startsWith(path, prefix)) return yield next;
        path = path.substr(prefix.length);
      }
      yield that.handleRequest(this, path, next);
    };
  };
});

module.exports = KindaRepositoryServer;
