function serializeMeta(meta) {
  if (!meta) {
    return undefined;
  }

  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      code: meta.code,
      stack: process.env.NODE_ENV === 'production' ? undefined : meta.stack
    };
  }

  if (Array.isArray(meta)) {
    return meta.map(serializeMeta);
  }

  if (typeof meta === 'object') {
    return Object.fromEntries(
      Object.entries(meta)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, serializeMeta(value)])
    );
  }

  return meta;
}

function write(level, message, meta) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message
  };

  const serializedMeta = serializeMeta(meta);
  if (serializedMeta && (typeof serializedMeta !== 'object' || Object.keys(serializedMeta).length > 0)) {
    payload.meta = serializedMeta;
  }

  const line = JSON.stringify(payload);
  if (level === 'error') {
    process.stderr.write(`${line}\n`);
    return;
  }

  process.stdout.write(`${line}\n`);
}

module.exports = {
  debug(message, meta) {
    if (process.env.NODE_ENV !== 'production') {
      write('debug', message, meta);
    }
  },
  info(message, meta) {
    write('info', message, meta);
  },
  warn(message, meta) {
    write('warn', message, meta);
  },
  error(message, meta) {
    write('error', message, meta);
  },
  audit(message, meta) {
    write('info', message, meta);
  }
};
