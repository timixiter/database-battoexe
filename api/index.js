import { kv } from '@vercel/kv';

// Helper: dapatkan lokasi dari IP (gunakan ip-api.com)
async function getLocation(ip) {
  if (!ip || ip === 'unknown') return { country: 'Unknown', city: 'Unknown', region: '' };
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon`);
    const data = await res.json();
    if (data.status === 'success') {
      return { country: data.country, region: data.regionName, city: data.city, lat: data.lat, lon: data.lon };
    }
  } catch (_) {}
  return { country: 'Unknown', city: 'Unknown', region: '' };
}

// Generate ID acak (jika tidak diisi)
function generateInvoiceId() {
  return 'INV-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

export default async function handler(req, res) {
  // CORS agar dapat diakses dari mana saja (termasuk dashboard)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Hanya terima POST (untuk keseragaman)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, invoice, device_info, ip, fingerprint, serial, newInvoiceId } = req.body;

  try {
    // Key untuk menyimpan daftar semua invoice
    const INVOICE_SET_KEY = 'invoices';

    if (action === 'validate') {
      if (!invoice) return res.status(400).json({ error: 'Invoice required' });
      const data = await kv.get(`invoice:${invoice}`);
      if (!data) return res.json({ valid: false, message: 'Invoice tidak ditemukan' });
      if (data.activated) return res.json({ valid: false, message: 'Invoice sudah digunakan' });
      return res.json({ valid: true, message: 'Invoice valid' });
    }

    if (action === 'activate') {
      if (!invoice) return res.status(400).json({ error: 'Invoice required' });
      const key = `invoice:${invoice}`;
      const data = await kv.get(key);
      if (!data) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
      if (data.activated) {
        // Cek apakah device sama (fingerprint atau serial)
        const existingFingerprint = data.fingerprint || '';
        const existingSerial = data.serial || '';
        const currentFingerprint = fingerprint || '';
        const currentSerial = serial || '';
        // Jika fingerprint atau serial cocok, izinkan (re-aktivasi perangkat sama)
        if (existingFingerprint === currentFingerprint || existingSerial === currentSerial) {
          // Update waktu aktivasi (opsional)
          await kv.set(key, { ...data, activatedAt: new Date().toISOString() });
          return res.json({ success: true, message: 'Re-aktivasi berhasil' });
        }
        return res.json({ success: false, message: 'Invoice sudah digunakan oleh perangkat lain' });
      }

      // Dapatkan lokasi dari IP
      const location = await getLocation(ip || 'unknown');

      // Update data
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
      await kv.set(key, updated);
      return res.json({ success: true, message: 'Aktivasi berhasil' });
    }

    if (action === 'list') {
      // Ambil semua invoice ID dari set
      const ids = await kv.smembers(INVOICE_SET_KEY);
      const invoices = [];
      for (const id of ids) {
        const data = await kv.get(`invoice:${id}`);
        if (data) {
          invoices.push({ invoice: id, ...data });
        }
      }
      return res.json({ success: true, data: invoices });
    }

    if (action === 'add') {
      let id = newInvoiceId ? newInvoiceId.trim() : '';
      if (!id) {
        // Generate otomatis
        id = generateInvoiceId();
      } else {
        // Cek apakah sudah ada
        const exists = await kv.get(`invoice:${id}`);
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
      await kv.set(`invoice:${id}`, newData);
      await kv.sadd(INVOICE_SET_KEY, id);
      return res.json({ success: true, message: 'Invoice berhasil ditambahkan', invoice: id });
    }

    if (action === 'delete') {
      if (!invoice) return res.status(400).json({ error: 'Invoice required' });
      const key = `invoice:${invoice}`;
      const exists = await kv.get(key);
      if (!exists) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
      await kv.del(key);
      await kv.srem(INVOICE_SET_KEY, invoice);
      return res.json({ success: true, message: 'Invoice dihapus' });
    }

    if (action === 'reset') {
      if (!invoice) return res.status(400).json({ error: 'Invoice required' });
      const key = `invoice:${invoice}`;
      const data = await kv.get(key);
      if (!data) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
      // Reset status dan hapus data perangkat, tapi pertahankan createdAt
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
      await kv.set(key, resetData);
      return res.json({ success: true, message: 'Invoice direset' });
    }

    if (action === 'stats') {
      const ids = await kv.smembers(INVOICE_SET_KEY);
      let total = ids.length;
      let active = 0;
      for (const id of ids) {
        const data = await kv.get(`invoice:${id}`);
        if (data && data.activated) active++;
      }
      return res.json({ success: true, total, active, inactive: total - active });
    }

    return res.status(400).json({ error: 'Action tidak dikenal' });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
    }
