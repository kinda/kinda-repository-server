'use strict';

let _ = require('lodash');
let Qs = require('qs');
let co = require('co');
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
      this.on(event, fn);
    });
  };
});

let KindaRepositoryServer = KindaObject.extend('KindaRepositoryServer', function() {
  this.include(KindaEventManager);

  // Options:
  //   signInWithCredentialsHandler:
  //     async function(credentials) {
  //       if (!credentials) return;
  //       if (credentials.username !== 'user@domain.com') return;
  //       if (credentials.password !== 'password') return;
  //       return 'secret-token';
  //     }
  //   signInWithAuthorizationHandler:
  //     async function(authorization) {
  //       return authorization === 'secret-token';
  //     },
  //   signOutHandler:
  //     async function(authorization) {
  //       // delete authorization token...
  //     },
  //   authorizeHandler:
  //     async function(request) {
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

  this.handleRequest = async function(ctx, path, next) {
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

    await this._handleRequest(ctx, slug, path, next);
  };

  this._handleRequest = async function(ctx, slug, path, next) {
    // monkey patched in kinda-repository-synchronizer/history-server.js
    if (slug === '') {
      await this.handleGetRepositoryIdRequest(ctx);
      return;
    }

    if (slug === 'ping') {
      await this.handlePingRequest(ctx);
      return;
    }

    if (slug === 'authorizations') {
      await this.handleAuthorizationRequest(ctx, path, next);
      return;
    }

    let registeredCollection = this.registeredCollections[slug];
    if (registeredCollection) {
      await this.handleCollectionRequest(ctx, registeredCollection, path, next);
      return;
    }

    await co(next);
  };

  this.readBody = async function(ctx) {
    ctx.request.body = await co(function *() {
      return yield parseBody.json(ctx, { limit: '8mb' });
    });
  };

  this.authorizationUnserializer = function(obj) { // can be overridden
    return obj.query && obj.query.authorization;
  };

  this.authorizeRequest = async function(ctx, method, request) {
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
    let isAuthorized = await handler(request);
    if (!isAuthorized) ctx.throw(403, 'authorization failed');
  };

  // === Repository requests ===

  this.handleGetRepositoryIdRequest = async function(ctx) {
    await this.authorizeRequest(ctx, 'getRepositoryId');
    let id = await this.repository.getRepositoryId();
    ctx.body = { repositoryId: id };
  };

  this.handlePingRequest = async function(ctx) {
    ctx.body = 'pong';
    ctx.logLevel = 'silence';
  };

  // === Authorization requests ===

  this.handleAuthorizationRequest = async function(ctx, path, next) {
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
      await this.handleSignInWithCredentialsRequest(ctx);
    } else if (method === 'GET' && fragment && !path) {
      await this.handleSignInWithAuthorizationRequest(ctx, fragment);
    } else if (method === 'DELETE' && fragment && !path) {
      await this.handleSignOutRequest(ctx, fragment);
    } else {
      await co(next);
    }
  };

  this.handleSignInWithCredentialsRequest = async function(ctx) {
    await this.readBody(ctx);
    let handler = this.signInWithCredentialsHandler;
    if (!handler) throw new Error('signInWithCredentialsHandler is undefined');
    let authorization = await handler(ctx.request.body);
    if (!authorization) ctx.throw(403, 'sign in with credentials failed');
    ctx.status = 201;
    ctx.body = authorization;
  };

  this.handleSignInWithAuthorizationRequest = async function(ctx, authorization) {
    let handler = this.signInWithAuthorizationHandler;
    if (!handler) throw new Error('signInWithAuthorizationHandler is undefined');
    let isOkay = await handler(authorization);
    if (!isOkay) ctx.throw(403, 'sign in with authorization failed');
    ctx.status = 204;
  };

  this.handleSignOutRequest = async function(ctx, authorization) {
    let handler = this.signOutHandler;
    if (!handler) throw new Error('signOutHandler is undefined');
    await handler(authorization);
    ctx.status = 204;
  };

  // === Collection requests ===

  this.handleCollectionRequest = async function(ctx, registeredCollection, path, next) {
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
      await this.handleGetItemsRequest(ctx);
    } else if (method === 'GET' && fragment1 === 'count' && !fragment2) {
      await this.handleCountItemsRequest(ctx);
    } else if ((method === 'GET' || method === 'POST') && (ctx.registeredCollection.collectionMethods.hasOwnProperty(camelCasedFragment1)) && !fragment2) {
      await this.handleCustomCollectionMethodRequest(ctx, camelCasedFragment1);
    } else if ((method === 'GET' || method === 'POST') && fragment1 && (ctx.registeredCollection.itemMethods.hasOwnProperty(camelCasedFragment2))) {
      await this.handleCustomItemMethodRequest(ctx, fragment1, camelCasedFragment2);
    } else if (method === 'GET' && fragment1 && !fragment2) {
      await this.handleGetItemRequest(ctx, fragment1);
    } else if (method === 'POST' && !fragment1 && !fragment2) {
      await this.handlePostItemRequest(ctx);
    } else if (method === 'PUT' && fragment1 && !fragment2) {
      await this.handlePutItemRequest(ctx, fragment1);
    } else if (method === 'DELETE' && fragment1 && !fragment2) {
      await this.handleDeleteItemRequest(ctx, fragment1);
    } else if (method === 'GET' && !fragment1 && !fragment2) {
      await this.handleFindItemsRequest(ctx);
    } else if (method === 'DELETE' && !fragment1 && !fragment2) {
      await this.handleFindAndDeleteItemsRequest(ctx);
    } else {
      await co(next);
    }
  };

  this.emitEvent = async function(ctx, event, request) {
    if (!request) request = {};
    request.authorization = ctx.authorization;
    request.collection = ctx.collection;
    request.remoteCollection = ctx.remoteCollection;
    request.event = event;
    request.options = ctx.options;
    await ctx.registeredCollection.emit(event, request);
  };

  this._getItem = async function(ctx, id, errorIfMissing) {
    if (errorIfMissing == null) errorIfMissing = ctx.options.errorIfMissing;
    if (errorIfMissing == null) errorIfMissing = true;
    if (!id) ctx.throw(400, 'id required');
    let item = await ctx.collection.getItem(id, { errorIfMissing: false });
    if (!item && errorIfMissing) ctx.throw(404, 'item not found');
    return item;
  };

  this.handleGetItemRequest = async function(ctx, id) {
    let item = await this._getItem(ctx, id);
    await this.authorizeRequest(ctx, 'getItem', { item });
    let remoteItem;
    if (item) {
      let className = item.class.name;
      let remoteCollection = this.remoteRepository.createCollectionFromItemClassName(className);
      remoteItem = remoteCollection.unserializeItem(item);
    }
    await this.emitEvent(ctx, 'didGetItem', { remoteItem, item });
    if (remoteItem) {
      ctx.body = {
        class: remoteItem.class.name,
        value: remoteItem.serialize()
      };
    } else {
      ctx.status = 204;
    }
  };

  this.handlePostItemRequest = async function(ctx) {
    await this.readBody(ctx);
    let remoteItem = ctx.remoteCollection.unserializeItem(ctx.request.body);
    await ctx.collection.transaction(async function() {
      let item = ctx.collection.createItem(remoteItem);
      await this.authorizeRequest(ctx, 'putItem', { remoteItem, item });
      await this.emitEvent(ctx, 'willPutItem', { remoteItem, item });
      await item.save(ctx.options);
      remoteItem = ctx.remoteCollection.unserializeItem(item);
      await this.emitEvent(ctx, 'didPutItem', { remoteItem, item });
      ctx.status = 201;
      ctx.body = {
        class: remoteItem.class.name,
        value: remoteItem.serialize()
      };
    }.bind(this));
  };

  this.handlePutItemRequest = async function(ctx, id) {
    await this.readBody(ctx);
    let remoteItem = ctx.remoteCollection.unserializeItem(ctx.request.body);
    await ctx.collection.transaction(async function() {
      let errorIfMissing = ctx.options.createIfMissing ? false : undefined;
      let item = await this._getItem(ctx, id, errorIfMissing);
      await this.authorizeRequest(ctx, 'putItem', { remoteItem, item });
      if (item) {
        item.updateValue(remoteItem);
      } else {
        item = ctx.collection.unserializeItem(remoteItem);
        item.isNew = false;
      }
      await this.emitEvent(ctx, 'willPutItem', { remoteItem, item });
      await item.save(ctx.options);
      remoteItem = ctx.remoteCollection.createItem(item);
      await this.emitEvent(ctx, 'didPutItem', { remoteItem, item });
      ctx.status = 200;
      ctx.body = {
        class: remoteItem.class.name,
        value: remoteItem.serialize()
      };
    }.bind(this));
  };

  this.handleDeleteItemRequest = async function(ctx, id) {
    let hasBeenDeleted = false;
    let item = await this._getItem(ctx, id);
    if (item) {
      await this.authorizeRequest(ctx, 'deleteItem', { item });
      await this.emitEvent(ctx, 'willDeleteItem', { item });
      hasBeenDeleted = await item.delete(ctx.options);
      if (hasBeenDeleted) await this.emitEvent(ctx, 'didDeleteItem', { item });
    }
    ctx.body = hasBeenDeleted;
  };

  this.handleGetItemsRequest = async function(ctx) {
    await this.readBody(ctx);
    await this.authorizeRequest(ctx, 'getItems');
    let items = await ctx.collection.getItems(ctx.request.body, ctx.options);
    let cache = {};
    let remoteItems = items.map(item => {
      let className = item.class.name;
      let remoteCollection = this.remoteRepository.createCollectionFromItemClassName(className, cache);
      return remoteCollection.unserializeItem(item);
    });
    await this.emitEvent(ctx, 'didGetItems', { remoteItems, items });
    ctx.status = 201;
    ctx.body = remoteItems.map(remoteItem => {
      return {
        class: remoteItem.class.name,
        value: remoteItem.serialize()
      };
    });
  };

  this.handleFindItemsRequest = async function(ctx) {
    await this.authorizeRequest(ctx, 'findItems');
    let items = await ctx.collection.findItems(ctx.options);
    let cache = {};
    let remoteItems = items.map(item => {
      let className = item.class.name;
      let remoteCollection = this.remoteRepository.createCollectionFromItemClassName(className, cache);
      return remoteCollection.unserializeItem(item);
    });
    await this.emitEvent(ctx, 'didFindItems', { remoteItems, items });
    ctx.status = 200;
    ctx.body = remoteItems.map(remoteItem => {
      return {
        class: remoteItem.class.name,
        value: remoteItem.serialize()
      };
    });
  };

  this.handleCountItemsRequest = async function(ctx) {
    await this.authorizeRequest(ctx, 'countItems');
    let count = await ctx.collection.countItems(ctx.options);
    await this.emitEvent(ctx, 'didCountItems', { count });
    ctx.status = 200;
    ctx.body = count;
  };

  this.handleFindAndDeleteItemsRequest = async function(ctx) {
    await this.authorizeRequest(ctx, 'findAndDeleteItems');
    let deletedItemsCount = await ctx.collection.findAndDeleteItems(ctx.options);
    await this.emitEvent(ctx, 'didFindAndDeleteItems');
    ctx.body = deletedItemsCount;
  };

  this.handleCustomCollectionMethodRequest = async function(ctx, method) {
    if (ctx.method === 'POST') await this.readBody(ctx);
    await this.authorizeRequest(ctx, method);
    let fn = ctx.registeredCollection.collectionMethods[method];
    if (fn === true) {
      fn = async function(request) {
        return {
          body: await request.collection[method](request.options)
        };
      };
    }
    let result = await this._callCustomMethod(ctx, fn);
    this._writeCustomMethodResult(ctx, result);
  };

  this.handleCustomItemMethodRequest = async function(ctx, id, method) {
    if (ctx.method === 'POST') await this.readBody(ctx);
    let item = await this._getItem(ctx, id);
    await this.authorizeRequest(ctx, method, { item });
    let fn = ctx.registeredCollection.itemMethods[method];
    if (fn === true) {
      fn = async function(request) {
        return {
          body: await request.item[method](request.options)
        };
      };
    }
    let result = await this._callCustomMethod(ctx, fn, { item });
    this._writeCustomMethodResult(ctx, result);
  };

  this._callCustomMethod = async function(ctx, fn, request = {}) {
    request.collection = ctx.collection;
    request.remoteCollection = ctx.remoteCollection;
    request.options = ctx.options;
    request.body = ctx.request.body;
    return await fn.call(this, request);
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
