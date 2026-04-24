(function initMCLBRealtimeStream(globalScope) {
  class AuthorizedRealtimeConnection {
    constructor(options = {}) {
      this.url = String(options.url || '');
      this.tokenProvider = typeof options.tokenProvider === 'function'
        ? options.tokenProvider
        : async () => (typeof apiService !== 'undefined' ? apiService.getToken() : null);
      this.onOpen = typeof options.onOpen === 'function' ? options.onOpen : null;
      this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
      this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
      this.onError = typeof options.onError === 'function' ? options.onError : null;
      this.onClose = typeof options.onClose === 'function' ? options.onClose : null;
      this.reconnect = options.reconnect !== false;
      this.reconnectDelayMs = Math.max(500, Number(options.reconnectDelayMs) || 1500);
      this.maxReconnectDelayMs = Math.max(this.reconnectDelayMs, Number(options.maxReconnectDelayMs) || 15000);
      this.maxReconnectAttempts = Number.isFinite(Number(options.maxReconnectAttempts))
        ? Math.max(0, Number(options.maxReconnectAttempts))
        : Infinity;

      this._abortController = null;
      this._closedByUser = false;
      this._reconnectTimer = null;
      this._reconnectAttempts = 0;
      this._active = false;
    }

    start() {
      if (this._active || !this.url) {
        return this;
      }

      this._closedByUser = false;
      this._active = true;
      this._open();
      return this;
    }

    close() {
      this._closedByUser = true;
      this._active = false;

      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }

      if (this._abortController) {
        this._abortController.abort();
        this._abortController = null;
      }

      if (this.onClose) {
        try {
          this.onClose();
        } catch (error) {
          console.error('Realtime close handler failed:', error);
        }
      }
    }

    async _open() {
      if (!this._active || !this.url) {
        return;
      }

      const controller = new AbortController();
      this._abortController = controller;

      try {
        const token = await this.tokenProvider();
        const headers = {};
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetch(this.url, {
          method: 'GET',
          headers,
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal
        });

        if (!response.ok || !response.body) {
          throw new Error(`Stream request failed (${response.status})`);
        }

        this._reconnectAttempts = 0;
        if (this.onOpen) {
          try {
            this.onOpen(response);
          } catch (error) {
            console.error('Realtime open handler failed:', error);
          }
        }

        await this._consumeStream(response.body, controller.signal);

        if (!this._closedByUser) {
          this._scheduleReconnect(new Error('Stream closed'));
        }
      } catch (error) {
        if (error?.name === 'AbortError' || this._closedByUser) {
          return;
        }

        if (this.onError) {
          try {
            this.onError(error);
          } catch (handlerError) {
            console.error('Realtime error handler failed:', handlerError);
          }
        }

        this._scheduleReconnect(error);
      }
    }

    async _consumeStream(streamBody, signal) {
      const reader = streamBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = 'message';
      let currentData = [];

      const flushEvent = () => {
        if (currentData.length === 0) {
          currentEvent = 'message';
          return;
        }

        const payloadText = currentData.join('\n');
        let parsedPayload = payloadText;

        try {
          parsedPayload = JSON.parse(payloadText);
        } catch (_) {
          parsedPayload = payloadText;
        }

        if (currentEvent === 'message' && this.onMessage) {
          this.onMessage(parsedPayload, { event: currentEvent, raw: payloadText });
        }

        if (this.onEvent) {
          this.onEvent(currentEvent, parsedPayload, { raw: payloadText });
        }

        currentEvent = 'message';
        currentData = [];
      };

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const segments = buffer.split(/\r?\n/);
        buffer = segments.pop() || '';

        for (const line of segments) {
          if (!line) {
            flushEvent();
            continue;
          }

          if (line.startsWith(':')) {
            continue;
          }

          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim() || 'message';
            continue;
          }

          if (line.startsWith('data:')) {
            currentData.push(line.slice(5).trimStart());
          }
        }
      }

      if (currentData.length > 0) {
        flushEvent();
      }
    }

    _scheduleReconnect(error) {
      if (!this._active || this._closedByUser || !this.reconnect) {
        return;
      }

      if (Number.isFinite(this.maxReconnectAttempts) && this._reconnectAttempts >= this.maxReconnectAttempts) {
        return;
      }

      const delay = Math.min(
        this.maxReconnectDelayMs,
        this.reconnectDelayMs * Math.pow(2, this._reconnectAttempts)
      );

      this._reconnectAttempts += 1;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._open();
      }, delay);

      if (error) {
        console.warn(`Realtime stream reconnect scheduled in ${delay}ms`, error);
      }
    }
  }

  globalScope.MCLBRealtimeStream = {
    connect(options = {}) {
      return new AuthorizedRealtimeConnection(options).start();
    }
  };
})(window);
