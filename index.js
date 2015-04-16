"use strict";

var _ = require('lodash');
var parseBody = require('co-body');
var KindaObject = require('kinda-object');
var util = require('kinda-util').create();

var KindaRepositoryServer = KindaObject.extend('KindaRepositoryServer', function() {
  this.setCreator(function(options) {
    if (!options) options = {};
    if (options.authorizer) this.setAuthorizer(options.authorizer);
    this.collections = [];
  });

  this.authorizationUnserializer = function(obj) { // can be overridden
    return obj.query && obj.query.authorization;
  };

  this.addCollection = function(backendClass, frontendClass, options) {
    if (!options) options = {};
    var slug = _.kebabCase(frontendClass.name);
    var collection = KindaObject.create();
    collection.backendClass = backendClass;
    collection.frontendClass = frontendClass;
    collection.slug = slug;
    collection.authorizer = options.authorizer;
    collection.collectionMethods = options.collectionMethods || {};
    collection.itemMethods = options.itemMethods || {};
    _.forOwn(options.eventListeners, function(fn, event) {
      collection.onAsync(event, fn);
    });
    this.collections.push(collection);
  };

  this.getAuthorizer = function() {
    return this._authorizer;
  };

  // Example of authorizer:
  // function *(authorization, { collection, item, method, options }) {
  //   return authorization === 'secret-token';
  // }
  this.setAuthorizer = function(authorizer) {
    this._authorizer = authorizer;
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
    var collection = _.find(this.collections, 'slug', slug);
    if (!collection) return yield next;
    this.readAuthorization(ctx);
    ctx.options = util.decodeObject(ctx.query);
    ctx.collection = collection;
    ctx.backendCollection = collection.backendClass.create();
    ctx.backendCollection.context = this;
    ctx.frontendCollection = collection.frontendClass.create();
    ctx.frontendCollection.context = this;
    yield this.handleCollectionRequest(ctx, path, next);
  };

  this.readAuthorization = function(ctx) {
    var query = util.decodeObject(ctx.query);
    ctx.authorization = this.authorizationUnserializer({ query: query });
  };

  this.readBody = function *(ctx) {
    ctx.request.body = yield parseBody.json(ctx, { limit: '8mb' });
  };

  this.handleCollectionRequest = function *(ctx, path, next) {
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
    } else {
      yield next;
    }
  };

  this.authorizeRequest = function *(ctx, method, request) {
    if (!request) request = {};
    var authorizer = ctx.collection.authorizer || this.getAuthorizer();
    if (!authorizer) return;
    request.authorization = ctx.authorization;
    request.backendCollection = ctx.backendCollection;
    request.frontendCollection = ctx.frontendCollection;
    request.method = method;
    request.options = ctx.options;
    var isAuthorized = yield authorizer(request);
    if (!isAuthorized) ctx.throw(403, 'authorization failed');
  };

  this.emitEvent = function *(ctx, event, request) {
    if (!request) request = {};
    request.backendCollection = ctx.backendCollection;
    request.frontendCollection = ctx.frontendCollection;
    request.event = event;
    request.options = ctx.options;
    yield ctx.collection.emitAsync(event, request);
  };

  this._getItem = function *(ctx, id) {
    if (!id) ctx.throw(400, 'id required');
    var item = yield ctx.backendCollection.getItem(id, { errorIfMissing: false });
    if (!item) {
      var errorIfMissing = ctx.options.errorIfMissing;
      if (errorIfMissing == null) errorIfMissing = true;
      if (errorIfMissing) ctx.throw(404, 'item not found');
    }
    return item;
  };

  this.handleGetItemRequest = function *(ctx, id) {
    var item = yield this._getItem(ctx, id);
    yield this.authorizeRequest(ctx, 'getItem', { backendItem: item });
    var frontendItem = item && ctx.frontendCollection.unserializeItem(item);
    yield this.emitEvent(ctx, 'didGetItem', {
      frontendItem: frontendItem, backendItem: item
    });
    if (frontendItem) {
      ctx.body = frontendItem.serialize();
    } else {
      ctx.status = 204;
    }
  };

  this.handlePostItemRequest = function *(ctx) {
    yield this.readBody(ctx);
    var frontendItem = ctx.frontendCollection.unserializeItem(ctx.request.body);
    yield ctx.backendCollection.transaction(function *() {
      var item = ctx.backendCollection.createItem(frontendItem);
      yield this.authorizeRequest(ctx, 'putItem', {
        frontendItem: frontendItem, backendItem: item
      });
      yield this.emitEvent(ctx, 'willPutItem', {
        frontendItem: frontendItem, backendItem: item
      });
      yield item.save();
      frontendItem = ctx.frontendCollection.unserializeItem(item);
      yield this.emitEvent(ctx, 'didPutItem', {
        frontendItem: frontendItem, backendItem: item
      });
      ctx.status = 201;
      ctx.body = frontendItem.serialize();
    }.bind(this));
  };

  this.handlePutItemRequest = function *(ctx, id) {
    yield this.readBody(ctx);
    var frontendItem = ctx.frontendCollection.unserializeItem(ctx.request.body);
    yield ctx.backendCollection.transaction(function *() {
      var item = yield this._getItem(ctx, id);
      yield this.authorizeRequest(ctx, 'putItem', {
        frontendItem: frontendItem, backendItem: item
      });
      item.updateValue(frontendItem);
      yield this.emitEvent(ctx, 'willPutItem', {
        frontendItem: frontendItem, backendItem: item
      });
      yield item.save();
      frontendItem = ctx.frontendCollection.unserializeItem(item);
      yield this.emitEvent(ctx, 'didPutItem', {
        frontendItem: frontendItem, backendItem: item
      });
      ctx.status = 200;
      ctx.body = frontendItem.serialize();
    }.bind(this));
  };

  this.handleDeleteItemRequest = function *(ctx, id) {
    var item = yield this._getItem(ctx, id);
    if (item) {
      yield this.authorizeRequest(ctx, 'deleteItem', { backendItem: item });
      yield this.emitEvent(ctx, 'willDeleteItem', { backendItem: item });
      yield item.delete();
      yield this.emitEvent(ctx, 'didDeleteItem', { backendItem: item });
    }
    ctx.status = 204;
  };

  this.handleFindItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'findItems');
    var items = yield ctx.backendCollection.findItems(ctx.options);
    var frontendItems = items.map(function(item) {
      return ctx.frontendCollection.unserializeItem(item);
    }, this);
    yield this.emitEvent(ctx, 'didFindItems', {
      frontendItems: frontendItems, backendItems: items
    });
    ctx.status = 200;
    ctx.body = _.invoke(frontendItems, 'serialize');
  };

  this.handleCountItemsRequest = function *(ctx) {
    yield this.authorizeRequest(ctx, 'countItems');
    var count = yield ctx.backendCollection.countItems(ctx.options);
    yield this.emitEvent(ctx, 'didCountItems', {
      count: count
    });
    ctx.status = 200;
    ctx.body = count;
  };

  this.handleCustomCollectionMethodRequest = function *(ctx, method) {
    if (ctx.method === 'POST') yield this.readBody(ctx);
    yield this.authorizeRequest(ctx, method);
    var fn = ctx.collection.collectionMethods[method];
    if (fn === true) {
      fn = function *(request) {
        return {
          body: yield request.backendCollection[method](request.options)
        }
      };
    }
    var result = yield this._callCustomMethod(ctx, fn);
    this._writeCustomMethodResult(ctx, result);
  };

  this.handleCustomItemMethodRequest = function *(ctx, id, method) {
    if (ctx.method === 'POST') yield this.readBody(ctx);
    var item = yield this._getItem(ctx, id);
    yield this.authorizeRequest(ctx, method, { backendItem: item });
    var fn = ctx.collection.itemMethods[method];
    if (fn === true) {
      fn = function *(request) {
        return {
          body: yield request.backendItem[method](request.options)
        }
      };
    }
    var result = yield this._callCustomMethod(ctx, fn, { backendItem: item });
    this._writeCustomMethodResult(ctx, result);
  };

  this._callCustomMethod = function *(ctx, fn, request) {
    if (!request) request = {};
    request.backendCollection = ctx.backendCollection;
    request.frontendCollection = ctx.frontendCollection;
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
