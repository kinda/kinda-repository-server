var repositoryServer = KindaRepositoryServer.create(
  backendRepository,
  frontendRepository,
  {
    collections: {
      Users: {
        authorizeHandler: function *(request) {
          return request.authorization === 'secret-token';
        }
      }
    }
  }
);
