import { Redis } from '@upstash/redis';

// Inisialisasi Redis dari environment variables (otomatis dari Vercel)
const redis = Redis.fromEnv();

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

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    const { action, invoice, device_info, ip, fingerprint, serial, newInvoiceId } = body;

    const INVOICE_SET_KEY = 'invoices';

    // ========== VALIDATE ==========
    if (action === 'validate') {
      if (!invoice) return res.status(400).json({ error: 'Invoice required' });
      const data = await redis.get(`invoice:${invoice}`);
      if (!data) return res.json({ valid: false, message: 'Invoice tidak ditemukan' });
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      if (parsed.activated) return res.json({ valid: false, message: 'Invoice sudah digunakan' });
      return res.json({ valid: true, message: 'Invoice valid' });
    }

    // ========== ACTIVATE ==========
    if (action === 'activate') {
      if (!invoice) return res.status(400).json({ error: 'Invoice required' });
      const key = `invoice:${invoice}`;
      const raw = await redis.get(key);
      if (!raw) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (data.activated) {
        const existingFingerprint = data.fingerprint || '';
        const existingSerial = data.serial || '';
        const currentFingerprint = fingerprint || '';
        const currentSerial = serial || '';
        if (existingFingerprint === currentFingerprint || existingSerial === currentSerial) {
          const updated = { ...data, activatedAt: new Date().toISOString() };
          await redis.set(key, JSON.stringify(updated));
          return res.json({ success: true, message: 'Re-aktivasi berhasil' });
        }
        return res.json({ success: false, message: 'Invoice sudah digunakan oleh perangkat lain' });
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
      return res.json({ success: true, message: 'Aktivasi berhasil' });
    }

    // ========== LIST ==========
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
      return res.json({ success: true, data: invoices });
    }

    // ========== ADD ==========
    if (action === 'add') {
      let id = newInvoiceId ? newInvoiceId.trim() : '';
      if (!id) {
        id = generateInvoiceId();
      } else {
        const exists = await redis.get(`invoice:${id}`);
        if (exists) return res.json({ success: false, message: 'Invoice ID sudah ada' });
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
      return res.json({ success: true, message: 'Invoice berhasil ditambahkan', invoice: id });
    }

    // ========== DELETE ==========
    if (action === 'delete') {
      if (!invoice) return res.status(400).json({ error: 'Invoice required' });
      const exists = await redis.get(`invoice:${invoice}`);
      if (!exists) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
      await redis.del(`invoice:${invoice}`);
      await redis.srem(INVOICE_SET_KEY, invoice);
      return res.json({ success: true, message: 'Invoice dihapus' });
    }

    // ========== RESET ==========
    if (action === 'reset') {
      if (!invoice) return res.status(400).json({ error: 'Invoice required' });
      const raw = await redis.get(`invoice:${invoice}`);
      if (!raw) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
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
      return res.json({ success: true, message: 'Invoice direset' });
    }

    // ========== STATS ==========
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
      return res.json({ success: true, total, active, inactive: total - active });
    }

    return res.status(400).json({ error: 'Action tidak dikenal' });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal server error: ' + error.message, stack: error.stack });
  }
        }
