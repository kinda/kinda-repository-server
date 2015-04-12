"use strict";

var _ = require('lodash');
var parseBody = require('co-body');
var KindaObject = require('kinda-object');
var util = require('kinda-util').create();

var KindaRepositoryServer = KindaObject.extend('KindaRepositoryServer', function() {
  this.setCreator(function() {
    this.collections = [];
  });

  this.addCollection = function(backendClass, frontendClass, options) {
    if (!options) options = {};
    var slug = _.kebabCase(frontendClass.name);
    var collection = {
      backendClass: backendClass,
      frontendClass: frontendClass,
      slug: slug
    };
    this.collections.push(collection);
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
    ctx.backendCollection = collection.backendClass.create();
    ctx.backendCollection.context = this;
    ctx.frontendCollection = collection.frontendClass.create();
    ctx.frontendCollection.context = this;
    yield this.handleCollectionRequest(ctx, path);
  };

  this.handleCollectionRequest = function *(ctx, path) {
    if (_.startsWith(path, '/')) path = path.slice(1);
    ctx.options = util.decodeObject(ctx.query);
    var method = ctx.method;
    if (method === 'GET' && path === 'count') {
      yield this.handleCountItemsRequest(ctx);
    } else if (method === 'GET' && path) {
      yield this.handleGetItemRequest(ctx, path);
    } else if (method === 'POST' && !path) {
      yield this.handlePostItemRequest(ctx);
    } else if (method === 'PUT' && path) {
      yield this.handlePutItemRequest(ctx, path);
    } else if (method === 'DELETE' && path) {
      yield this.handleDeleteItemRequest(ctx, path);
    } else if (method === 'GET' && !path) {
      yield this.handleFindItemsRequest(ctx);
    } else {
      ctx.throw(405); // Method Not Allowed
    }
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
    if (item) {
      ctx.body = ctx.frontendCollection.unserializeItem(item).serialize();
    } else {
      ctx.status = 204;
    }
  };

  this.handlePostItemRequest = function *(ctx) {
    var requestBody = yield parseBody.json(ctx);
    var item = ctx.frontendCollection.unserializeItem(requestBody);
    yield ctx.backendCollection.transaction(function *() {
      item = ctx.backendCollection.createItem(item);
      yield item.save();
      ctx.status = 201;
      ctx.body = ctx.frontendCollection.unserializeItem(item).serialize();
    }.bind(this));
  };

  this.handlePutItemRequest = function *(ctx, id) {
    var requestBody = yield parseBody.json(ctx);
    var newItem = ctx.frontendCollection.unserializeItem(requestBody);
    yield ctx.backendCollection.transaction(function *() {
      var item = yield this._getItem(ctx, id);
      item.setValue(newItem);
      yield item.save();
      ctx.status = 200;
      ctx.body = ctx.frontendCollection.unserializeItem(item).serialize();
    }.bind(this));
  };
  
  this.handleDeleteItemRequest = function *(ctx, id) {
    var item = yield this._getItem(ctx, id);
    if (item) yield item.delete();
    ctx.status = 204;
  };

  this.handleFindItemsRequest = function *(ctx) {
    var items = yield ctx.backendCollection.findItems(ctx.options);
    items = items.map(function(item) {
      return ctx.frontendCollection.unserializeItem(item).serialize();
    }, this);
    ctx.status = 200;
    ctx.body = items;
  };

  this.handleCountItemsRequest = function *(ctx) {
    var count = yield ctx.backendCollection.countItems(ctx.options);
    ctx.status = 200;
    ctx.body = count;
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
