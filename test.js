'use strict';

let http = require('http');
let nodeURL = require('url');
let querystring = require('querystring');
let fs = require('fs');
let nodePath = require('path');
let os = require('os');
let assert = require('chai').assert;
let _ = require('lodash');
let koa = require('koa');
let Collection = require('kinda-collection');
let KindaLocalRepository = require('kinda-local-repository');
let httpClient = require('kinda-http-client').create({ json: true });
let util = require('kinda-util').create();
let KindaRepositoryServer = require('./src');

suite('KindaRepositoryServer', function() {
  let users, httpServer, serverURL;

  suiteSetup(async function() {
    let serverPort = 8888;
    let serverPrefix = '/v1';

    let Users = Collection.extend('Users', function() {
      this.Item = this.Item.extend('User', function() {
        this.addPrimaryKeyProperty('id', String);
        this.addProperty('firstName', String);
        this.addProperty('age', Number);

        this.get = async function() {
          return this.serialize();
        };

        this.generateReport = async function() {
          let path = nodePath.join(os.tmpdir(), 'report-123456.txt');
          fs.writeFileSync(path, 'Hello, World!');
          return path;
        };
      });

      this.countRetired = async function() {
        let items = await this.findItems();
        let count = 0;
        items.forEach(function(item) {
          if (item.age >= 60) count++;
        });
        return count;
      };

      this.echo = async function(data) {
        return data;
      };
    });

    let Superusers = Users.extend('Superusers', function() {
      this.Item = this.Item.extend('Superuser', function() {
        this.addProperty('superpower', String);
      });
    });

    let repository = KindaLocalRepository.create({
      name: 'Test',
      url: 'mysql://test@localhost/test',
      collections: [Users, Superusers]
    });

    let repositoryServer = KindaRepositoryServer.create({
      repository,
      async signInWithCredentialsHandler(credentials) {
        if (!credentials) return undefined;
        if (credentials.username !== 'mvila@3base.com') return undefined;
        if (credentials.password !== 'password') return undefined;
        return 'secret-token';
      },
      async signInWithAuthorizationHandler(authorization) {
        return authorization === 'secret-token';
      },
      async signOutHandler(authorization) { // eslint-disable-line
        // delete authorization token
      },
      async verifyAuthorizationHandler(request) {
        return request.authorization === 'secret-token';
      },
      collections: {
        Users: {
          collectionMethods: {
            countRetired: true,
            async echo(request) {
              return {
                body: await request.collection.echo(request.body)
              };
            }
          },
          itemMethods: {
            get: true,
            async generateReport(request) {
              let path = await request.item.generateReport();
              let stream = fs.createReadStream(path);
              stream.on('close', () => fs.unlink(path));
              return {
                headers: {
                  contentType: 'text/plain; charset=utf-8',
                  contentDisposition: 'inline; filename="report.txt"'
                },
                body: stream
              };
            }
          },
          eventListeners: {
            async willPutItem(request) {
              if (request.item.firstName === 'Bobby') {
                request.item.firstName = 'Bob';
              }
            }
          }
        }
      }
    });

    let server = koa();
    server.use(repositoryServer.getMiddleware(serverPrefix));
    httpServer = http.createServer(server.callback());
    httpServer.listen(serverPort);
    serverURL = 'http://localhost:' + serverPort + serverPrefix;

    users = repository.createCollection('Users');
  });

  suiteTeardown(async function() {
    httpServer.close();
    await users.repository.destroyRepository();
  });

  let writeAuthorization = function(params, authorization) {
    let parsedURL = nodeURL.parse(params.url, true);
    _.assign(parsedURL.query, { authorization });
    delete parsedURL.search;
    params.url = nodeURL.format(parsedURL);
  };

  test('test authorization', async function() {
    let url, body, res, credentials, params;

    url = serverURL + '/superusers';
    body = { firstName: 'Manu', age: 42 };
    params = { method: 'POST', url, body };
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 403);

    url = serverURL + '/authorizations';
    credentials = { username: 'mvila@3base.com', password: 'wrongpass' };
    params = { method: 'POST', url, body: credentials };
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 403);

    url = serverURL + '/authorizations';
    credentials = { username: 'mvila@3base.com', password: 'password' };
    params = { method: 'POST', url, body: credentials };
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body, 'secret-token');

    url = serverURL + '/authorizations/wrong-token';
    res = await httpClient.get(url);
    assert.strictEqual(res.statusCode, 403);

    url = serverURL + '/authorizations/secret-token';
    res = await httpClient.get(url);
    assert.strictEqual(res.statusCode, 204);

    url = serverURL + '/authorizations/secret-token';
    res = await httpClient.del(url);
    assert.strictEqual(res.statusCode, 204);
  });

  test('get repository id', async function() {
    let url = serverURL;
    let params = { method: 'GET', url };
    writeAuthorization(params, 'secret-token');
    let res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.repositoryId);
  });

  test('put, get and delete an item', async function() {
    let url = serverURL + '/superusers';
    let body = { firstName: 'Manu', age: 42, superpower: 'telepathy' };
    let params = { method: 'POST', url, body };
    writeAuthorization(params, 'secret-token');
    let res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 201);
    let result = res.body;
    assert.strictEqual(result.class, 'Superuser');
    let id = result.value.id;
    assert.ok(id);
    assert.strictEqual(result.value.firstName, 'Manu');
    assert.strictEqual(result.value.age, 42);
    assert.strictEqual(result.value.superpower, 'telepathy');

    url = serverURL + '/users/' + id;
    params = { method: 'GET', url };
    writeAuthorization(params, 'secret-token');
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    result = res.body;
    assert.strictEqual(result.class, 'Superuser');
    assert.strictEqual(result.value.id, id);
    assert.strictEqual(result.value.firstName, 'Manu');
    assert.strictEqual(result.value.age, 42);
    assert.strictEqual(result.value.superpower, 'telepathy');

    url = serverURL + '/superusers/' + id;
    body = { id, firstName: 'Manu', age: 43, superpower: 'telepathy' };
    params = { method: 'PUT', url, body };
    writeAuthorization(params, 'secret-token');
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    result = res.body;
    assert.strictEqual(result.class, 'Superuser');
    assert.strictEqual(result.value.id, id);
    assert.strictEqual(result.value.firstName, 'Manu');
    assert.strictEqual(result.value.age, 43);
    assert.strictEqual(result.value.superpower, 'telepathy');

    url = serverURL + '/users/' + id;
    params = { method: 'GET', url };
    writeAuthorization(params, 'secret-token');
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    result = res.body;
    assert.strictEqual(result.class, 'Superuser');
    assert.strictEqual(result.value.id, id);
    assert.strictEqual(result.value.firstName, 'Manu');
    assert.strictEqual(result.value.age, 43);
    assert.strictEqual(result.value.superpower, 'telepathy');

    url = serverURL + '/users/' + id;
    params = { method: 'DELETE', url };
    writeAuthorization(params, 'secret-token');
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, true);

    let options = { errorIfMissing: false };
    let query = querystring.stringify(util.encodeValue(options));
    url = serverURL + '/users/' + id + '?' + query;
    params = { method: 'GET', url };
    writeAuthorization(params, 'secret-token');
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 204);
    assert.isUndefined(res.body);
  });

  test('get a missing item', async function() {
    let url = serverURL + '/users/xyz';
    let params = { method: 'GET', url };
    writeAuthorization(params, 'secret-token');
    let res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 404);

    let options = { errorIfMissing: false };
    let query = querystring.stringify(util.encodeValue(options));
    url = serverURL + '/users/xyz?' + query;
    params = { method: 'GET', url };
    writeAuthorization(params, 'secret-token');
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 204);
    assert.isUndefined(res.body);
  });

  test('delete a missing item', async function() {
    let url = serverURL + '/users/xyz';
    let params = { method: 'DELETE', url };
    writeAuthorization(params, 'secret-token');
    let res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 404);

    let options = { errorIfMissing: false };
    let query = querystring.stringify(util.encodeValue(options));
    url = serverURL + '/users/xyz?' + query;
    params = { method: 'DELETE', url };
    writeAuthorization(params, 'secret-token');
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, false);
  });

  test('use event listeners', async function() {
    let url = serverURL + '/users';
    let body = { firstName: 'Bobby', age: 31 };
    let params = { method: 'POST', url, body };
    writeAuthorization(params, 'secret-token');
    let res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 201);
    let result = res.body;
    let id = result.value.id;
    assert.ok(id);
    assert.strictEqual(result.value.firstName, 'Bob');
    assert.strictEqual(result.value.age, 31);

    url = serverURL + '/users/' + id;
    params = { method: 'GET', url };
    writeAuthorization(params, 'secret-token');
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    result = res.body;
    assert.strictEqual(result.value.id, id);
    assert.strictEqual(result.value.firstName, 'Bob');
    assert.strictEqual(result.value.age, 31);

    url = serverURL + '/users/' + id;
    params = { method: 'DELETE', url };
    writeAuthorization(params, 'secret-token');
    res = await httpClient.request(params);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, true);
  });

  suite('with many items', function() {
    setup(async function() {
      await users.putItem({ id: 'aaa', firstName: 'Bob', age: 20 });
      await users.putItem({ id: 'bbb', firstName: 'Jack', age: 62 });
      await users.putItem({ id: 'ccc', firstName: 'Alan', age: 40 });
      await users.putItem({ id: 'ddd', firstName: 'Joe', age: 40 });
      await users.putItem({ id: 'eee', firstName: 'John', age: 30 });
    });

    teardown(async function() {
      await users.deleteItem('aaa', { errorIfMissing: false });
      await users.deleteItem('bbb', { errorIfMissing: false });
      await users.deleteItem('ccc', { errorIfMissing: false });
      await users.deleteItem('ddd', { errorIfMissing: false });
      await users.deleteItem('eee', { errorIfMissing: false });
    });

    test('get serveral items at once', async function() {
      let ids = ['aaa', 'eee'];
      let url = serverURL + '/users/get-items';
      let params = { method: 'POST', url, body: ids };
      writeAuthorization(params, 'secret-token');
      let res = await httpClient.request(params);
      assert.strictEqual(res.statusCode, 201);
      let items = _.pluck(res.body, 'value');
      assert.deepEqual(items, [
        { id: 'aaa', firstName: 'Bob', age: 20 },
        { id: 'eee', firstName: 'John', age: 30 }
      ]);
    });

    test('find items between two existing items', async function() {
      let options = { start: 'bbb', end: 'ccc' };
      let query = querystring.stringify(util.encodeValue(options));
      let url = serverURL + '/users?' + query;
      let params = { method: 'GET', url };
      writeAuthorization(params, 'secret-token');
      let res = await httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      let items = _.pluck(res.body, 'value');
      assert.deepEqual(items, [
        { id: 'bbb', firstName: 'Jack', age: 62 },
        { id: 'ccc', firstName: 'Alan', age: 40 }
      ]);
    });

    test('count items', async function() {
      let url = serverURL + '/users/count';
      let params = { method: 'GET', url };
      writeAuthorization(params, 'secret-token');
      let res = await httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body, 5);

      let options = { start: 'bbb', end: 'ccc' };
      let query = querystring.stringify(util.encodeValue(options));
      url = serverURL + '/users/count?' + query;
      params = { method: 'GET', url };
      writeAuthorization(params, 'secret-token');
      res = await httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body, 2);
    });

    test('find and delete items between two existing items', async function() {
      let options = { start: 'bbb', end: 'ccc' };
      let query = querystring.stringify(util.encodeValue(options));
      let url = serverURL + '/users?' + query;
      let params = { method: 'DELETE', url };
      writeAuthorization(params, 'secret-token');
      let res = await httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body, 2);

      url = serverURL + '/users/count';
      params = { method: 'GET', url };
      writeAuthorization(params, 'secret-token');
      res = await httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body, 3);
    });

    test('call custom method on a collection', async function() {
      let url = serverURL + '/users/count-retired';
      let params = { method: 'GET', url };
      writeAuthorization(params, 'secret-token');
      let res = await httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body, 1);
    });

    test('call custom method on an item', async function() {
      let url = serverURL + '/users/aaa/get';
      let params = { method: 'GET', url };
      writeAuthorization(params, 'secret-token');
      let res = await httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      assert.deepEqual(res.body, { id: 'aaa', firstName: 'Bob', age: 20 });
    });

    test('call custom method with a body', async function() {
      let data = [{ id: 'aaa', firstName: 'Bob', age: 20 }];
      let url = serverURL + '/users/echo';
      let params = { method: 'POST', url, body: data };
      writeAuthorization(params, 'secret-token');
      let res = await httpClient.request(params);
      assert.strictEqual(res.statusCode, 201);
      assert.deepEqual(res.body, data);
    });

    test('call custom method returning a file', async function() {
      let url = serverURL + '/users/aaa/generate-report';
      let params = { method: 'GET', url };
      writeAuthorization(params, 'secret-token');
      let res = await httpClient.request(params);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/plain; charset=utf-8');
      assert.strictEqual(res.headers['content-disposition'], 'inline; filename="report.txt"');
      assert.strictEqual(res.body, 'Hello, World!');
    });
  });
});
