"use strict";

var _ = require('lodash');
var parseBody = require('co-body');
var KindaObject = require('kinda-object');
var util = require('kinda-util').create();

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
  this.setCreator(function(localRepository, remoteRepository, options) {
    if (!options) options = {};
    this.localRepository = localRepository;
    this.remoteRepository = remoteRepository;
    _.assign(this, _.pick(options, [
      'signInWithCredentialsHandler',
      'signInWithAuthorizationHandler',
      'signOutHandler',
      'authorizeHandler'
    ]));
    this.collections = {};
    var collectionOptions = options.collections || {};
    _.forOwn(remoteRepository.collectionClasses, function(klass, name) {
      if (!localRepository.collectionClasses[name]) {
        throw new Error('collection \'' + name + '\' is undefined in the local repository');
      }
      this._addCollection(name, collectionOptions[name]);
    }, this);
  });

  this._addCollection = function(name, options) {
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
    this.collections[slug] = collection;
  };

  this.handleRequest = function *(ctx, path, next) {
    var slug = path;
    if (_.startsWith(slug, '/')) slug = slug.slice(1);
    var index = slug.indexOf('/');
    if (index !== -1) {
      path = slug.slice(index);
      slug = slug.slice(0, index);
    } else {
      path = '';
    }
    if (slug === 'authorizations') {
      yield this.handleAuthorizationRequest(ctx, path, next);
      return;
    }
    var collection = this.collections[slug];
    if (collection) {
      yield this.handleCollectionRequest(ctx, collection, path, next);
      return;
    }
    yield next;
  };

  this.readBody = function *(ctx) {
    ctx.request.body = yield parseBody.json(ctx, { limit: '8mb' });
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

  this.handleCollectionRequest = function *(ctx, collection, path, next) {
    ctx.collection = collection;
    ctx.localCollection = this.localRepository.createCollection(collection.name);
    ctx.localCollection.context = this;
    ctx.remoteCollection = this.remoteRepository.createCollection(collection.name);
    ctx.remoteCollection.context = this;
    ctx.options = util.decodeObject(ctx.query);

    this.readAuthorization(ctx);

    var fragment1 = path;
    var fragment2 = '';
    if (_.startsWith(fragment1, '/')) fragment1 = fragment1.slice(1);
    var index = fragment1.indexOf('/');
    if (index !== -1) {
      fragment2 = fragment1.slice(index + 1);
      fragment1 = fragment1.slice(0, index);
    }

    var method = ctx.method;
    if (method === 'GET' && fragment1 === 'count' && !fragment2) {
      yield this.handleCountItemsRequest(ctx);
    } else if ((method === 'GET' || method === 'POST') && (ctx.collection.collectionMethods.hasOwnProperty(fragment1)) && !fragment2) {
      yield this.handleCustomCollectionMethodRequest(ctx, fragment1);
    } else if ((method === 'GET' || method === 'POST') && fragment1 && (ctx.collection.itemMethods.hasOwnProperty(fragment2))) {
      yield this.handleCustomItemMethodRequest(ctx, fragment1, fragment2);
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

  this.readAuthorization = function(ctx) {
    var query = util.decodeObject(ctx.query);
    ctx.authorization = this.authorizationUnserializer({ query: query });
  };

  this.authorizationUnserializer = function(obj) { // can be overridden
    return obj.query && obj.query.authorization;
  };

  this.authorizeRequest = function *(ctx, method, request) {
    if (!request) request = {};
    var handler = ctx.collection.authorizeHandler || this.authorizeHandler;
    if (!handler) return;
    request.authorization = ctx.authorization;
    request.localCollection = ctx.localCollection;
    request.remoteCollection = ctx.remoteCollection;
    request.method = method;
    request.options = ctx.options;
    var isAuthorized = yield handler(request);
    if (!isAuthorized) ctx.throw(403, 'authorization failed');
  };

  this.emitEvent = function *(ctx, event, request) {
    if (!request) request = {};
    request.localCollection = ctx.localCollection;
    request.remoteCollection = ctx.remoteCollection;
    request.event = event;
    request.options = ctx.options;
    yield ctx.collection.emitAsync(event, request);
  };

  this._getItem = function *(ctx, id) {
    if (!id) ctx.throw(400, 'id required');
    var item = yield ctx.localCollection.getItem(id, { errorIfMissing: false });
    if (!item) {
      var errorIfMissing = ctx.options.errorIfMissing;
      if (errorIfMissing == null) errorIfMissing = true;
      if (errorIfMissing) ctx.throw(404, 'item not found');
    }
    return item;
  };

  this.handleGetItemRequest = function *(ctx, id) {
    var item = yield this._getItem(ctx, id);
    yield this.authorizeRequest(ctx, 'getItem', { localItem: item });
    var remoteItem = item && ctx.remoteCollection.unserializeItem(item);
    yield this.emitEvent(ctx, 'didGetItem', {
      remoteItem: remoteItem, localItem: item
    });
    if (remoteItem) {
      ctx.body = remoteItem.serialize();
    } else {
      ctx.status = 204;
    }
  };

  this.handlePostItemRequest = function *(ctx) {
    yield this.readBody(ctx);
    var remoteItem = ctx.remoteCollection.unserializeItem(ctx.request.body);
    yield ctx.localCollection.transaction(function *() {
      var item = ctx.localCollection.createItem(remoteItem);
      yield this.authorizeRequest(ctx, 'putItem', {
        remoteItem: remoteItem, localItem: item
      });
      yield this.emitEvent(ctx, 'willPutItem', {
        remoteItem: remoteItem, localItem: item
      });
      yield item.save();
      remoteItem = ctx.remoteCollection.unserializeItem(item);
      yield this.emitEvent(ctx, 'didPutItem', {
        remoteItem: remoteItem, localItem: item
      });
      ctx.status = 201;
      ctx.body = remoteItem.serialize();
    }.bind(this));
  };

  this.handlePutItemRequest = function *(ctx, id) {
    yield this.readBody(ctx);
    var remoteItem = ctx.remoteCollection.unserializeItem(ctx.request.body);
    yield ctx.localCollection.transaction(function *() {
      var item = yield this._getItem(ctx, id);
      yield this.authorizeRequest(ctx, 'putItem', {
        remoteItem: remoteItem, localItem: item
      });
      item.updateValue(remoteItem);
      yield this.emitEvent(ctx, 'willPutItem', {
        remoteItem: remoteItem, localItem: item
      });
      yield item.save();
      remoteItem = ctx.remoteCollection.unserializeItem(item);
      yield this.emitEvent(ctx, 'didPutItem', {
        remoteItem: remoteItem, localItem: item
      });
      ctx.status = 200;
      ctx.body = remoteItem.serialize();
    }.bind(this));
  };

  this.handleDeleteItemRequest = function *(ctx, id) {
    var item = yield this._getItem(ctx, id);
    if (item) {
      yield this.authorizeRequest(ctx, 'deleteItem', { localItem: item });
      yield this.emitEvent(ctx, 'willDeleteItem', { localItem: item });
      yield item.delete();
      yield this.emitEvent(ctx, 'didDeleteItem', { localItem: item });
    }
    ctx.status = 204;
  };

  this.handleFindItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'findItems');
    var items = yield ctx.localCollection.findItems(ctx.options);
    var remoteItems = items.map(function(item) {
      return ctx.remoteCollection.unserializeItem(item);
    }, this);
    yield this.emitEvent(ctx, 'didFindItems', {
      remoteItems: remoteItems, localItems: items
    });
    ctx.status = 200;
    ctx.body = _.invoke(remoteItems, 'serialize');
  };

  this.handleCountItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'countItems');
    var count = yield ctx.localCollection.countItems(ctx.options);
    yield this.emitEvent(ctx, 'didCountItems', {
      count: count
    });
    ctx.status = 200;
    ctx.body = count;
  };

  this.handleFindAndDeleteItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'findAndDeleteItems');
    yield ctx.localCollection.findAndDeleteItems(ctx.options);
    yield this.emitEvent(ctx, 'didFindAndDeleteItems');
    ctx.status = 204;
  };

  this.handleCustomCollectionMethodRequest = function *(ctx, method) {
    if (ctx.method === 'POST') yield this.readBody(ctx);
    yield this.authorizeRequest(ctx, method);
    var fn = ctx.collection.collectionMethods[method];
    if (fn === true) {
      fn = function *(request) {
        return {
          body: yield request.localCollection[method](request.options)
        }
      };
    }
    var result = yield this._callCustomMethod(ctx, fn);
    this._writeCustomMethodResult(ctx, result);
  };

  this.handleCustomItemMethodRequest = function *(ctx, id, method) {
    if (ctx.method === 'POST') yield this.readBody(ctx);
    var item = yield this._getItem(ctx, id);
    yield this.authorizeRequest(ctx, method, { localItem: item });
    var fn = ctx.collection.itemMethods[method];
    if (fn === true) {
      fn = function *(request) {
        return {
          body: yield request.localItem[method](request.options)
        }
      };
    }
    var result = yield this._callCustomMethod(ctx, fn, { localItem: item });
    this._writeCustomMethodResult(ctx, result);
  };

  this._callCustomMethod = function *(ctx, fn, request) {
    if (!request) request = {};
    request.localCollection = ctx.localCollection;
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
