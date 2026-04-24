(function () {
  // Do not install global handler on the error page itself.
  const currentPage = (typeof window !== 'undefined')
    ? window.location.pathname.split('/').pop()
    : '';
  if (currentPage === 'error.html') return;

  function navigateToErrorPage(error) {
    if (typeof window === 'undefined') return;

    try {
      const status = error && typeof error.status === 'number' ? String(error.status) : '';
      const code = error && typeof error.code === 'string' ? error.code : 'SERVER_ERROR';
      const message = (error && (error.message || error.data?.message)) || 'Unexpected backend error.';
      const endpoint = error && typeof error.endpoint === 'string' ? error.endpoint : '';

      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (code) params.set('code', code);
      if (message) params.set('message', message);
      if (endpoint) params.set('endpoint', endpoint);

      window.location.href = `error.html?${params.toString()}`;
    } catch (navError) {
      console.error('Failed to navigate to error page:', navError);
    }
  }

  // Surface helper globally for explicit use in page code when needed.
  if (typeof window !== 'undefined') {
    window.mclbNavigateToErrorPage = navigateToErrorPage;
  }
})();

