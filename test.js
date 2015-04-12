"use strict";

var http = require('http');
var querystring = require('querystring');
require('co-mocha');
var assert = require('chai').assert;
var _ = require('lodash');
var koa = require('koa');
var Collection = require('kinda-collection');
var KindaDB = require('kinda-db');
var KindaDBRepository = require('kinda-db-repository');
var httpClient = require('kinda-http-client').create();
var util = require('kinda-util').create();
var KindaRepositoryServer = require('./');

suite('KindaRepositoryServer', function() {
  var users, httpServer, serverURL;

  var catchError = function *(fn) {
    var err;
    try {
      yield fn();
    } catch (e) {
      err = e
    }
    return err;
  };

  suiteSetup(function *() {
    var serverPort = 8888;
    var serverPrefix = '/v1';

    var db = KindaDB.create('Test', 'mysql://test@localhost/test');
    db.registerMigration(1, function *() {
      yield this.addTable('Users');
    });
    yield db.initializeDatabase();

    var repository = KindaDBRepository.create(db);

    var Users = Collection.extend('Users', function() {
      this.Item = this.Item.extend('User', function() {
        this.addPrimaryKeyProperty('id', String);
        this.addProperty('firstName', String);
        this.addProperty('age', Number);
      });
      this.setRepository(repository);
    });

    users = Users.create();

    var repositoryServer = KindaRepositoryServer.create();
    repositoryServer.addCollection(Users, Users);

    var server = koa();
    server.use(repositoryServer.getMiddleware('/v1'));
    httpServer = http.createServer(server.callback());
    httpServer.listen(serverPort);
    serverURL = 'http://localhost:' + serverPort + serverPrefix;
  });

  suiteTeardown(function *() {
    httpServer.close();
    yield users.getRepository().database.destroyDatabase();
  });

  test('put, get and delete an item', function *() {
    var url = serverURL + '/users';
    var body = { firstName: 'Manu', age: 42 };
    var params = { method: 'POST', url: url, body: body };
    var res = yield httpClient.request(params);
    assert.strictEqual(res.statusCode, 201);
    var id = res.body.id;
    assert.ok(id);
    assert.strictEqual(res.body.firstName, 'Manu');
    assert.strictEqual(res.body.age, 42);

    var url = serverURL + '/users/' + id;
    var params = { method: 'GET', url: url };
    var res = yield httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.id, id);
    assert.strictEqual(res.body.firstName, 'Manu');
    assert.strictEqual(res.body.age, 42);

    var url = serverURL + '/users/' + id;
    var body = { id: id, firstName: 'Manu', age: 43 };
    var params = { method: 'PUT', url: url, body: body };
    var res = yield httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.id, id);
    assert.strictEqual(res.body.firstName, 'Manu');
    assert.strictEqual(res.body.age, 43);

    var url = serverURL + '/users/' + id;
    var params = { method: 'GET', url: url };
    var res = yield httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.id, id);
    assert.strictEqual(res.body.firstName, 'Manu');
    assert.strictEqual(res.body.age, 43);

    var url = serverURL + '/users/' + id;
    var params = { method: 'DELETE', url: url };
    var res = yield httpClient.request(params);
    assert.strictEqual(res.statusCode, 204);

    var options = { errorIfMissing: false };
    var query = querystring.stringify(util.encodeObject(options));
    var url = serverURL + '/users/' + id + '?' + query;
    var params = { method: 'GET', url: url };
    var res = yield httpClient.request(params);
    assert.strictEqual(res.statusCode, 204);
    assert.isUndefined(res.body);
  });

  test('get a missing item', function *() {
    var url = serverURL + '/users/xyz';
    var params = { method: 'GET', url: url };
    var res = yield httpClient.request(params);
    assert.strictEqual(res.statusCode, 404);

    var options = { errorIfMissing: false };
    var query = querystring.stringify(util.encodeObject(options));
    var url = serverURL + '/users/xyz?' + query;
    var params = { method: 'GET', url: url };
    var res = yield httpClient.request(params);
    assert.strictEqual(res.statusCode, 204);
    assert.isUndefined(res.body);
  });

  test('delete a missing item', function *() {
    var url = serverURL + '/users/xyz';
    var params = { method: 'DELETE', url: url };
    var res = yield httpClient.request(params);
    assert.strictEqual(res.statusCode, 404);

    var options = { errorIfMissing: false };
    var query = querystring.stringify(util.encodeObject(options));
    var url = serverURL + '/users/xyz?' + query;
    var params = { method: 'DELETE', url: url };
    var res = yield httpClient.request(params);
    assert.strictEqual(res.statusCode, 204);
    assert.isUndefined(res.body);
  });

  suite('with many items', function() {
    setup(function *() {
      yield users.putItem({ id: 'aaa', firstName: 'Bob', age: 20 });
      yield users.putItem({ id: 'bbb', firstName: 'Jack', age: 52 });
      yield users.putItem({ id: 'ccc', firstName: 'Alan', age: 40 });
      yield users.putItem({ id: 'ddd', firstName: 'Joe', age: 40 });
      yield users.putItem({ id: 'eee', firstName: 'John', age: 30 });
    });

    teardown(function *() {
      yield users.deleteItem('aaa', { errorIfMissing: false });
      yield users.deleteItem('bbb', { errorIfMissing: false });
      yield users.deleteItem('ccc', { errorIfMissing: false });
      yield users.deleteItem('ddd', { errorIfMissing: false });
      yield users.deleteItem('eee', { errorIfMissing: false });
    });

    test('find items between two existing items', function *() {
      var options = { start: 'bbb', end: 'ccc' };
      var query = querystring.stringify(util.encodeObject(options));
      var url = serverURL + '/users?' + query;
      var params = { method: 'GET', url: url };
      var res = yield httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      assert.deepEqual(res.body, [
        { id: 'bbb', firstName: 'Jack', age: 52 },
        { id: 'ccc', firstName: 'Alan', age: 40 }
      ]);
    });

    test('count items', function *() {
      var url = serverURL + '/users/count';
      var params = { method: 'GET', url: url };
      var res = yield httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body, 5);

      var options = { start: 'bbb', end: 'ccc' };
      var query = querystring.stringify(util.encodeObject(options));
      var url = serverURL + '/users/count?' + query;
      var params = { method: 'GET', url: url };
      var res = yield httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body, 2);
    });
  });
});
