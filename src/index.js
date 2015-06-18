'use strict';

let _ = require('lodash');
let Qs = require('qs');
let parseBody = require('co-body');
let KindaObject = require('kinda-object');
let KindaEventManager = require('kinda-event-manager');
let util = require('kinda-util').create();

// TODO: authorize handler, custom methods and event listeners should inherit from super classes

let RegisteredCollection = KindaObject.extend('RegisteredCollection', function() {
  this.include(KindaEventManager);

  this.creator = function(name, options = {}) {
    this.name = name;
    this.slug = _.kebabCase(name);
    this.authorizeHandler = options.authorizeHandler;
    this.collectionMethods = options.collectionMethods || {};
    this.itemMethods = options.itemMethods || {};
    _.forOwn(options.eventListeners, (fn, event) => {
      this.onAsync(event, fn);
    });
  };
});

let KindaRepositoryServer = KindaObject.extend('KindaRepositoryServer', function() {
  this.include(KindaEventManager);

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
  this.creator = function(options = {}) {
    if (!options.repository) throw new Error('repository is missing');
    this.repository = options.repository;
    this.remoteRepository = options.remoteRepository || options.repository;
    _.assign(this, _.pick(options, [
      'signInWithCredentialsHandler',
      'signInWithAuthorizationHandler',
      'signOutHandler',
      'authorizeHandler'
    ]));
    this.registeredCollections = {};
    let collectionOptions = options.collections || {};
    _.forOwn(this.remoteRepository.collectionClasses, (klass, name) => {
      if (!this.repository.collectionClasses[name]) {
        throw new Error('collection \'' + name + '\' is undefined in the server repository');
      }
      this.registerCollection(name, collectionOptions[name]);
    });
  };

  this.use = function(plugin) {
    plugin.plug(this);
  };

  this.registerCollection = function(name, options) {
    let collection = RegisteredCollection.create(name, options);
    this.registeredCollections[collection.slug] = collection;
  };

  this.handleRequest = function *(ctx, path, next) {
    let query = Qs.parse(ctx.querystring);
    query = util.decodeValue(query);
    ctx.options = query;
    ctx.authorization = this.authorizationUnserializer({ query });

    let slug = path;
    if (_.startsWith(slug, '/')) slug = slug.slice(1);
    let index = slug.indexOf('/');
    if (index !== -1) {
      path = slug.slice(index);
      slug = slug.slice(0, index);
    } else {
      path = '';
    }

    yield this._handleRequest(ctx, slug, path, next);
  };

  this._handleRequest = function *(ctx, slug, path, next) {
    // monkey patched in kinda-repository-synchronizer/history-server.js
    if (slug === '') {
      yield this.handleGetRepositoryIdRequest(ctx);
      return;
    }

    if (slug === 'ping') {
      yield this.handlePingRequest(ctx);
      return;
    }

    if (slug === 'authorizations') {
      yield this.handleAuthorizationRequest(ctx, path, next);
      return;
    }

    let registeredCollection = this.registeredCollections[slug];
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
    let handler;
    if (ctx.registeredCollection) {
      handler = ctx.registeredCollection.authorizeHandler;
    }
    if (!handler) handler = this.authorizeHandler;
    if (!handler) return;
    request.authorization = ctx.authorization;
    request.collection = ctx.collection;
    request.remoteCollection = ctx.remoteCollection;
    request.method = method;
    request.options = ctx.options;
    let isAuthorized = yield handler(request);
    if (!isAuthorized) ctx.throw(403, 'authorization failed');
  };

  // === Repository requests ===

  this.handleGetRepositoryIdRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'getRepositoryId');
    let id = yield this.repository.getRepositoryId();
    ctx.body = { repositoryId: id };
  };

  this.handlePingRequest = function *(ctx) {
    ctx.body = 'pong';
    ctx.logLevel = 'silence';
  };

  // === Authorization requests ===

  this.handleAuthorizationRequest = function *(ctx, path, next) {
    let fragment = path;
    if (_.startsWith(fragment, '/')) fragment = fragment.slice(1);
    let index = fragment.indexOf('/');
    if (index !== -1) {
      path = fragment.slice(index + 1);
      fragment = fragment.slice(0, index);
    } else {
      path = '';
    }
    let method = ctx.method;
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
    let handler = this.signInWithCredentialsHandler;
    if (!handler) throw new Error('signInWithCredentialsHandler is undefined');
    let authorization = yield handler(ctx.request.body);
    if (!authorization) ctx.throw(403, 'sign in with credentials failed');
    ctx.status = 201;
    ctx.body = authorization;
  };

  this.handleSignInWithAuthorizationRequest = function *(ctx, authorization) {
    let handler = this.signInWithAuthorizationHandler;
    if (!handler) throw new Error('signInWithAuthorizationHandler is undefined');
    let isOkay = yield handler(authorization);
    if (!isOkay) ctx.throw(403, 'sign in with authorization failed');
    ctx.status = 204;
  };

  this.handleSignOutRequest = function *(ctx, authorization) {
    let handler = this.signOutHandler;
    if (!handler) throw new Error('signOutHandler is undefined');
    yield handler(authorization);
    ctx.status = 204;
  };

  // === Collection requests ===

  this.handleCollectionRequest = function *(ctx, registeredCollection, path, next) {
    let name = registeredCollection.name;
    ctx.registeredCollection = registeredCollection;
    ctx.collection = this.repository.createCollection(name);
    ctx.remoteCollection = this.remoteRepository.createCollection(name);

    let fragment1 = path;
    let fragment2 = '';
    if (_.startsWith(fragment1, '/')) fragment1 = fragment1.slice(1);
    let index = fragment1.indexOf('/');
    if (index !== -1) {
      fragment2 = fragment1.slice(index + 1);
      fragment1 = fragment1.slice(0, index);
    }
    let camelCasedFragment1 = _.camelCase(fragment1);
    let camelCasedFragment2 = _.camelCase(fragment2);

    let method = ctx.method;
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

  this.emitEvent = function *(ctx, event, request) {
    if (!request) request = {};
    request.collection = ctx.collection;
    request.remoteCollection = ctx.remoteCollection;
    request.event = event;
    request.options = ctx.options;
    yield ctx.registeredCollection.emitAsync(event, request);
  };

  this._getItem = function *(ctx, id, errorIfMissing) {
    if (errorIfMissing == null) errorIfMissing = ctx.options.errorIfMissing;
    if (errorIfMissing == null) errorIfMissing = true;
    if (!id) ctx.throw(400, 'id required');
    let item = yield ctx.collection.getItem(id, { errorIfMissing: false });
    if (!item && errorIfMissing) ctx.throw(404, 'item not found');
    return item;
  };

  this.handleGetItemRequest = function *(ctx, id) {
    let item = yield this._getItem(ctx, id);
    yield this.authorizeRequest(ctx, 'getItem', { item });
    let remoteItem;
    if (item) {
      let className = item.class.name;
      let remoteCollection = this.remoteRepository.createCollectionFromItemClassName(className);
      remoteItem = remoteCollection.unserializeItem(item);
    }
    yield this.emitEvent(ctx, 'didGetItem', { remoteItem, item });
    if (remoteItem) {
      ctx.body = {
        class: remoteItem.class.name,
        value: remoteItem.serialize()
      };
    } else {
      ctx.status = 204;
    }
  };

  this.handlePostItemRequest = function *(ctx) {
    yield this.readBody(ctx);
    let remoteItem = ctx.remoteCollection.unserializeItem(ctx.request.body);
    yield ctx.collection.transaction(function *() {
      let item = ctx.collection.createItem(remoteItem);
      yield this.authorizeRequest(ctx, 'putItem', { remoteItem, item });
      yield this.emitEvent(ctx, 'willPutItem', { remoteItem, item });
      yield item.save(ctx.options);
      remoteItem = ctx.remoteCollection.unserializeItem(item);
      yield this.emitEvent(ctx, 'didPutItem', { remoteItem, item });
      ctx.status = 201;
      ctx.body = {
        class: remoteItem.class.name,
        value: remoteItem.serialize()
      };
    }.bind(this));
  };

  this.handlePutItemRequest = function *(ctx, id) {
    yield this.readBody(ctx);
    let remoteItem = ctx.remoteCollection.unserializeItem(ctx.request.body);
    yield ctx.collection.transaction(function *() {
      let errorIfMissing = ctx.options.createIfMissing ? false : undefined;
      let item = yield this._getItem(ctx, id, errorIfMissing);
      yield this.authorizeRequest(ctx, 'putItem', { remoteItem, item });
      if (item) {
        item.updateValue(remoteItem);
      } else {
        item = ctx.collection.unserializeItem(remoteItem);
        item.isNew = false;
      }
      yield this.emitEvent(ctx, 'willPutItem', { remoteItem, item });
      yield item.save(ctx.options);
      remoteItem = ctx.remoteCollection.createItem(item);
      yield this.emitEvent(ctx, 'didPutItem', { remoteItem, item });
      ctx.status = 200;
      ctx.body = {
        class: remoteItem.class.name,
        value: remoteItem.serialize()
      };
    }.bind(this));
  };

  this.handleDeleteItemRequest = function *(ctx, id) {
    let hasBeenDeleted = false;
    let item = yield this._getItem(ctx, id);
    if (item) {
      yield this.authorizeRequest(ctx, 'deleteItem', { item });
      yield this.emitEvent(ctx, 'willDeleteItem', { item });
      hasBeenDeleted = yield item.delete(ctx.options);
      if (hasBeenDeleted) yield this.emitEvent(ctx, 'didDeleteItem', { item });
    }
    ctx.body = hasBeenDeleted;
  };

  this.handleGetItemsRequest = function *(ctx) {
    yield this.readBody(ctx);
    yield this.authorizeRequest(ctx, 'getItems');
    let items = yield ctx.collection.getItems(ctx.request.body, ctx.options);
    let cache = {};
    let remoteItems = items.map(item => {
      let className = item.class.name;
      let remoteCollection = this.remoteRepository.createCollectionFromItemClassName(className, cache);
      return remoteCollection.unserializeItem(item);
    });
    yield this.emitEvent(ctx, 'didGetItems', { remoteItems, items });
    ctx.status = 201;
    ctx.body = remoteItems.map(remoteItem => {
      return {
        class: remoteItem.class.name,
        value: remoteItem.serialize()
      };
    });
  };

  this.handleFindItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'findItems');
    let items = yield ctx.collection.findItems(ctx.options);
    let cache = {};
    let remoteItems = items.map(item => {
      let className = item.class.name;
      let remoteCollection = this.remoteRepository.createCollectionFromItemClassName(className, cache);
      return remoteCollection.unserializeItem(item);
    });
    yield this.emitEvent(ctx, 'didFindItems', { remoteItems, items });
    ctx.status = 200;
    ctx.body = remoteItems.map(remoteItem => {
      return {
        class: remoteItem.class.name,
        value: remoteItem.serialize()
      };
    });
  };

  this.handleCountItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'countItems');
    let count = yield ctx.collection.countItems(ctx.options);
    yield this.emitEvent(ctx, 'didCountItems', { count });
    ctx.status = 200;
    ctx.body = count;
  };

  this.handleFindAndDeleteItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'findAndDeleteItems');
    let deletedItemsCount = yield ctx.collection.findAndDeleteItems(ctx.options);
    yield this.emitEvent(ctx, 'didFindAndDeleteItems');
    ctx.body = deletedItemsCount;
  };

  this.handleCustomCollectionMethodRequest = function *(ctx, method) {
    if (ctx.method === 'POST') yield this.readBody(ctx);
    yield this.authorizeRequest(ctx, method);
    let fn = ctx.registeredCollection.collectionMethods[method];
    if (fn === true) {
      fn = function *(request) {
        return {
          body: yield request.collection[method](request.options)
        };
      };
    }
    let result = yield this._callCustomMethod(ctx, fn);
    this._writeCustomMethodResult(ctx, result);
  };

  this.handleCustomItemMethodRequest = function *(ctx, id, method) {
    if (ctx.method === 'POST') yield this.readBody(ctx);
    let item = yield this._getItem(ctx, id);
    yield this.authorizeRequest(ctx, method, { item });
    let fn = ctx.registeredCollection.itemMethods[method];
    if (fn === true) {
      fn = function *(request) {
        return {
          body: yield request.item[method](request.options)
        };
      };
    }
    let result = yield this._callCustomMethod(ctx, fn, { item });
    this._writeCustomMethodResult(ctx, result);
  };

  this._callCustomMethod = function *(ctx, fn, request = {}) {
    request.collection = ctx.collection;
    request.remoteCollection = ctx.remoteCollection;
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
    let that = this;
    return function *(next) {
      let path = this.path;
      if (prefix) {
        if (!_.startsWith(path, prefix)) return yield next;
        path = path.substr(prefix.length);
      }
      yield that.handleRequest(this, path, next);
    };
  };
});

module.exports = KindaRepositoryServer;
