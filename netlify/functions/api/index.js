const { Redis } = require('@upstash/redis');

// ========== REDIS INIT ==========
function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.error('❌ Redis env missing');
    return null;
  }

  try {
    return new Redis({ url, token });
  } catch (err) {
    console.error('❌ Redis init error:', err.message);
    return null;
  }
}

const redis = getRedis();

// ========== HELPERS ==========
async function getLocation(ip) {
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1') {
    return { country: 'Unknown', region: 'Unknown', city: 'Unknown' };
  }
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`);
    const data = await res.json();
    if (data.status === 'success') {
      return { country: data.country, region: data.regionName, city: data.city };
    }
  } catch (_) {}
  return { country: 'Unknown', region: 'Unknown', city: 'Unknown' };
}

function generateInvoiceId() {
  return 'INV-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

// ========== HANDLER UTAMA ==========
exports.handler = async function(event, context) {
  // Log request
  console.log(`📨 ${event.httpMethod} ${event.path}`);

  // CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' })
    };
  }

  if (!redis) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Database not connected. Check UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.'
      })
    };
  }

  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  const { action, invoice, device_info, ip, fingerprint, serial, newInvoiceId } = body;
  const INVOICE_SET_KEY = 'invoices';

  try {
    // ===== VALIDATE =====
    if (action === 'validate') {
      if (!invoice) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invoice required' }) };
      }
      const raw = await redis.get(`invoice:${invoice}`);
      if (!raw) {
        return { statusCode: 200, headers, body: JSON.stringify({ valid: false, message: 'Invoice not found' }) };
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (data.activated) {
        return { statusCode: 200, headers, body: JSON.stringify({ valid: false, message: 'Invoice already used' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ valid: true, message: 'Invoice valid' }) };
    }

    // ===== ACTIVATE =====
    if (action === 'activate') {
      if (!invoice) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invoice required' }) };
      }
      const key = `invoice:${invoice}`;
      const raw = await redis.get(key);
      if (!raw) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Invoice not found' }) };
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (data.activated) {
        const existingFingerprint = data.fingerprint || '';
        const existingSerial = data.serial || '';
        const currentFingerprint = fingerprint || '';
        const currentSerial = serial || '';
        if (existingFingerprint === currentFingerprint || existingSerial === currentSerial) {
          data.activatedAt = new Date().toISOString();
          await redis.set(key, JSON.stringify(data));
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Re-activation successful' }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Invoice already used by another device' }) };
      }

      const location = await getLocation(ip || 'unknown');
      const updated = {
        ...data,
        activated: true,
        activatedAt: new Date().toISOString(),
        device_info: device_info || '',
        ip: ip || 'unknown',
        fingerprint: fingerprint || '',
        serial: serial || '',
        location,
      };
      await redis.set(key, JSON.stringify(updated));
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Activation successful' }) };
    }

    // ===== LIST =====
    if (action === 'list') {
      const ids = await redis.smembers(INVOICE_SET_KEY);
      const invoices = [];
      for (const id of ids) {
        const raw = await redis.get(`invoice:${id}`);
        if (raw) {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          invoices.push({ invoice: id, ...data });
        }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: invoices }) };
    }

    // ===== ADD =====
    if (action === 'add') {
      let id = newInvoiceId ? newInvoiceId.trim() : '';
      if (!id) {
        id = generateInvoiceId();
      } else {
        const exists = await redis.get(`invoice:${id}`);
        if (exists) {
          return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Invoice ID already exists' }) };
        }
      }
      const newData = {
        invoice: id,
        activated: false,
        createdAt: new Date().toISOString(),
        device_info: '',
        ip: '',
        fingerprint: '',
        serial: '',
        location: { country: '', region: '', city: '' }
      };
      await redis.set(`invoice:${id}`, JSON.stringify(newData));
      await redis.sadd(INVOICE_SET_KEY, id);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Invoice added', invoice: id }) };
    }

    // ===== DELETE =====
    if (action === 'delete') {
      if (!invoice) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invoice required' }) };
      }
      const exists = await redis.get(`invoice:${invoice}`);
      if (!exists) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Invoice not found' }) };
      }
      await redis.del(`invoice:${invoice}`);
      await redis.srem(INVOICE_SET_KEY, invoice);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Invoice deleted' }) };
    }

    // ===== RESET =====
    if (action === 'reset') {
      if (!invoice) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invoice required' }) };
      }
      const raw = await redis.get(`invoice:${invoice}`);
      if (!raw) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Invoice not found' }) };
      }
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const resetData = {
        ...data,
        activated: false,
        activatedAt: null,
        device_info: '',
        ip: '',
        fingerprint: '',
        serial: '',
        location: { country: '', region: '', city: '' }
      };
      await redis.set(`invoice:${invoice}`, JSON.stringify(resetData));
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Invoice reset' }) };
    }

    // ===== STATS =====
    if (action === 'stats') {
      const ids = await redis.smembers(INVOICE_SET_KEY);
      let total = ids.length;
      let active = 0;
      for (const id of ids) {
        const raw = await redis.get(`invoice:${id}`);
        if (raw) {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (data && data.activated) active++;
        }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, total, active, inactive: total - active }) };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Unknown action' })
    };
  } catch (error) {
    console.error('API Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};
