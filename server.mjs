import Fastify from 'fastify';
import JSZip from 'jszip';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const PORT = Number(process.env.PORT || 8080);
const PDF_SERVICE_KEY = process.env.PDF_SERVICE_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const GOTENBERG_URL = (process.env.GOTENBERG_URL || '').replace(/\/$/, '');
const PDF_MIN_BYTES = Number(process.env.PDF_MIN_BYTES || 51200);

const app = Fastify({ logger: false });

app.get('/health', async () => ({ ok: true }));

app.post('/render', async (req, reply) => {
  try {
    const apiKey = (req.headers['x-api-key'] || '').toString();
    if (!PDF_SERVICE_KEY || apiKey !== PDF_SERVICE_KEY) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }

    const body = req.body || {};
    const code = String(body.code || '').trim().toUpperCase();
    const srcUrl = String(body.srcUrl || body.src || '');
    const values = Object(body.values || body.userValues || {});
    const format = String(body.format || 'pdf').toLowerCase();
    if (!code || !srcUrl || format !== 'pdf') {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }

    // 1) Fetch source ODT/DOCX
    const srcRes = await fetch(srcUrl, { cache: 'no-store' });
    if (!srcRes.ok) return reply.code(400).send({ ok: false, error: 'source_fetch_failed' });
    const srcBuf = Buffer.from(await srcRes.arrayBuffer());

    // 2) Replace RMGC1..RMGC20 in XML parts
    let replaced = 0;
    const zip = await JSZip.loadAsync(srcBuf);
    const paths = Object.keys(zip.files).filter(p =>
      /^(word\/document|word\/header\d*|word\/footer\d*)\.xml$/i.test(p) ||
      /^(content\.xml|styles\.xml)$/i.test(p)
    );
    if (!paths.length) return reply.code(400).send({ ok: false, error: 'unknown_template_format' });

    for (const p of paths) {
      const f = zip.file(p);
      if (!f) continue;
      let xml = await f.async('string');
      for (let i = 1; i <= 20; i++) {
        const k = `RMGC${i}`;
        const v = (values[k] ?? '').toString();
        xml = xml.replace(new RegExp(k, 'g'), () => { replaced++; return v; });
      }
      zip.file(p, xml);
    }
    const modifiedBuf = await zip.generateAsync({ type: 'nodebuffer' });

    // 3) Convert via Gotenberg LibreOffice
    const fd = new FormData();
    fd.append('files', new Blob([modifiedBuf]), 'in.doc');
    const conv = await fetch(`${GOTENBERG_URL}/forms/libreoffice/convert`, { method: 'POST', body: fd });
    if (!conv.ok) return reply.code(502).send({ ok: false, error: 'gotenberg_failed' });
    const pdfBuf = Buffer.from(await conv.arrayBuffer());

    // 4) Guardrails
    if (pdfBuf.length < PDF_MIN_BYTES) return reply.code(502).send({ ok: false, error: 'pdf_too_small' });
    if (pdfBuf.subarray(0,5).toString('ascii') !== '%PDF-') return reply.code(502).send({ ok: false, error: 'not_pdf' });

    // 5) Upload to Supabase Storage
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const uuid = crypto.randomUUID();
    const storagePath = `tmp/${code}/${uuid}.pdf`;
    const { error: upErr } = await supabase.storage.from('reports')
      .upload(storagePath, pdfBuf, { contentType: 'application/pdf', upsert: false });
    if (upErr) return reply.code(502).send({ ok: false, error: 'upload_failed' });

    return reply.send({ ok: true, path: `reports/${storagePath}`, substitutions: replaced, bytes: pdfBuf.length });
  } catch {
    return reply.code(500).send({ ok: false, error: 'server_error' });
  }
});

app.listen({ port: PORT, host: '0.0.0.0' });
