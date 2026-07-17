const ALLOWED_ORIGINS = [
  'https://steadfastseniorservices.com',
  'https://steadfast-services.github.io',
  'http://localhost:8000',
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : null;
  if (!allow) return {};
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResp(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function genCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

function scheduleBackground(task, ctx) {
  const run = task.catch((err) => {
    console.error('Background task failed:', err);
  });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(run);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sendOtpEmail(env, toEmail, name, code) {
  const html = `<p>Hi ${name},</p><p>Your Steadfast Senior Services provider login code is:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>` +
    `<p>This code expires in 5 minutes. If you didn't request this, you can ignore this email.</p>`;
  const res = await fetchWithTimeout('https://api.emailjs.com/api/v1.0/email/send', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      service_id:  env.EMAILJS_SERVICE_ID,
      template_id: env.EMAILJS_TEMPLATE_ID,
      user_id:     env.EMAILJS_PUBLIC_KEY,
      accessToken: env.EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email:      toEmail,
        subject:       'Your Steadfast Senior Services login code',
        client_name:   '',
        provider_name: name,
        visit_date:    '',
        duration:      '',
        services:      '',
        family_notes:  '',
        provider_sig:  '',
        client_sig:    '',
        html_content:  html,
        wave_text:     '',
      },
    }),
  }, 15000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`EmailJS error ${res.status}: ${text}`);
  }
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CAPTURE_LEAD_TOOL = {
  name: 'capture_lead',
  description: "Call this when the visitor's question isn't answered by the knowledge base, they want to book/request service, they're asking about becoming a provider, or they ask to talk to a person. Only call it once you have at least a phone number or email to reach them — ask for that first if you don't have it yet. Classify the category correctly so it reaches the right team.",
  input_schema: {
    type: 'object',
    properties: {
      category:       { type: 'string', enum: ['booking', 'general_inquiry', 'join_team'], description: "'booking' for scheduling/requesting care service, 'join_team' for provider/job applicants, 'general_inquiry' for anything else the knowledge base doesn't cover" },
      name:           { type: 'string', description: "Visitor's name, if given" },
      contact:        { type: 'string', description: 'Phone number or email to reach them' },
      question:       { type: 'string', description: "Brief summary of what they're asking about" },
      preferred_time: { type: 'string', description: 'Preferred time to be contacted, if mentioned' },
    },
    required: ['category', 'contact', 'question'],
  },
};

const LEAD_FORM_ENDPOINTS = {
  booking:         'https://formspree.io/f/xvzjdjqg', // Family Inquiry
  general_inquiry: 'https://formspree.io/f/xvzjdjqg', // Family Inquiry
  join_team:       'https://formspree.io/f/xdaryrdl', // Provider Application
};

async function callClaude(env, { system, messages, tools }) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-5',
      max_tokens: 1024,
      system,
      messages,
      tools,
    }),
  }, 20000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function sendLeadEmail(env, { sessionId, category, name, contact, question, preferred_time }) {
  const endpoint = LEAD_FORM_ENDPOINTS[category] || LEAD_FORM_ENDPOINTS.general_inquiry;

  const res = await fetchWithTimeout(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({
      name:    name || '(not given via chat)',
      email:   contact || '',
      phone:   contact || '',
      message: `[From support chat, category: ${category}]\n\n${question || '(no question given)'}\n\nPreferred time to reach them: ${preferred_time || '(not given)'}\n\nChat session: ${sessionId}`,
      _subject: `New chat lead (${category}): ${name || contact || 'website visitor'}`,
    }),
  }, 15000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lead relay to Formspree failed ${res.status}: ${text}`);
  }

  await env.DB.prepare('UPDATE chat_leads SET emailed = 1 WHERE session_id = ? AND emailed = 0').bind(sessionId).run();
}

function getProviders(env) {
  const raw = env.PROVIDERS_JSON || '{}';
  return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
}

async function getSession(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT token, pin, name, role, expires_at FROM sessions WHERE token = ?'
  ).bind(token).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return row;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return jsonResp({ ok: false, error: 'Method not allowed' }, 405, origin);
    }

    const { pathname } = new URL(request.url);
    let body;
    try { body = await request.json(); }
    catch (_) { return jsonResp({ ok: false, error: 'Invalid JSON body' }, 400, origin); }

    // ── Auth: PIN entry → sends OTP email ──────────────────────────
    if (pathname === '/auth') {
      const pin = String(body.pin ?? '');
      const provider = getProviders(env)[pin];
      if (!provider) return jsonResp({ ok: false }, 200, origin);
      if (!provider.email) return jsonResp({ ok: false, error: 'no_email_on_file' }, 200, origin);

      const code = genCode();
      const now  = Date.now();
      await env.DB.prepare(
        `INSERT INTO otp_codes (pin, code, attempts, expires_at, last_sent_at)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(pin) DO UPDATE SET code = excluded.code, attempts = 0,
           expires_at = excluded.expires_at, last_sent_at = excluded.last_sent_at`
      ).bind(pin, code, now + 5 * 60 * 1000, now).run();

      scheduleBackground(sendOtpEmail(env, provider.email, provider.name, code), ctx);
      return jsonResp({ ok: true, requiresOtp: true, name: provider.name }, 200, origin);
    }

    // ── Verify OTP → issues session token ──────────────────────────
    if (pathname === '/verify-otp') {
      const pin  = String(body.pin ?? '');
      const code = String(body.code ?? '').trim();

      const row = await env.DB.prepare('SELECT * FROM otp_codes WHERE pin = ?').bind(pin).first();
      if (!row) return jsonResp({ ok: false, error: 'expired' }, 200, origin);
      if (Date.now() > row.expires_at) {
        await env.DB.prepare('DELETE FROM otp_codes WHERE pin = ?').bind(pin).run();
        return jsonResp({ ok: false, error: 'expired' }, 200, origin);
      }
      if (row.attempts >= 5) return jsonResp({ ok: false, error: 'locked' }, 200, origin);
      if (row.code !== code) {
        await env.DB.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE pin = ?').bind(pin).run();
        return jsonResp({ ok: false }, 200, origin);
      }

      await env.DB.prepare('DELETE FROM otp_codes WHERE pin = ?').bind(pin).run();

      const provider   = getProviders(env)[pin];
      const token      = crypto.randomUUID();
      const expiresAt  = Date.now() + 12 * 60 * 60 * 1000;
      await env.DB.prepare(
        'INSERT INTO sessions (token, pin, name, role, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(token, pin, provider.name, provider.role, expiresAt).run();

      return jsonResp({ ok: true, token, name: provider.name, role: provider.role }, 200, origin);
    }

    // ── Resend OTP ──────────────────────────────────────────────────
    if (pathname === '/resend-otp') {
      const pin = String(body.pin ?? '');
      const provider = getProviders(env)[pin];
      if (!provider || !provider.email) return jsonResp({ ok: false }, 200, origin);

      const existing = await env.DB.prepare('SELECT last_sent_at FROM otp_codes WHERE pin = ?').bind(pin).first();
      const now = Date.now();
      if (existing && now - existing.last_sent_at < 30 * 1000) {
        return jsonResp({ ok: false, error: 'rate_limited' }, 200, origin);
      }

      const code = genCode();
      await env.DB.prepare(
        `INSERT INTO otp_codes (pin, code, attempts, expires_at, last_sent_at)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(pin) DO UPDATE SET code = excluded.code, attempts = 0,
           expires_at = excluded.expires_at, last_sent_at = excluded.last_sent_at`
      ).bind(pin, code, now + 5 * 60 * 1000, now).run();

      scheduleBackground(sendOtpEmail(env, provider.email, provider.name, code), ctx);
      return jsonResp({ ok: true }, 200, origin);
    }

    // ── Client list ─────────────────────────────────────────────────
    if (pathname === '/clients-list') {
      const session = await getSession(env, body.token);
      if (!session) return jsonResp({ ok: false, error: 'unauthorized' }, 401, origin);

      const search = String(body.search || '').trim();
      const baseSelect = `SELECT c.id, c.full_name, c.family_email, c.care_tier,
             (SELECT MAX(visit_date) FROM visits v WHERE v.client_id = c.id) AS last_visit_date
           FROM clients c WHERE c.active = 1`;
      const stmt = search
        ? env.DB.prepare(baseSelect + ' AND c.full_name LIKE ? ORDER BY c.full_name').bind('%' + search + '%')
        : env.DB.prepare(baseSelect + ' ORDER BY c.full_name');
      const { results } = await stmt.all();

      return jsonResp({
        ok: true,
        clients: results.map(r => ({
          id: r.id,
          fullName: r.full_name,
          familyEmail: r.family_email,
          careTier: r.care_tier,
          lastVisitDate: r.last_visit_date,
        })),
      }, 200, origin);
    }

    // ── Client detail (+ visit history) ────────────────────────────
    if (pathname === '/client-detail') {
      const session = await getSession(env, body.token);
      if (!session) return jsonResp({ ok: false, error: 'unauthorized' }, 401, origin);

      const clientId = Number(body.clientId);
      const c = await env.DB.prepare(
        'SELECT id, full_name, family_email, address, care_tier, care_tier_notes FROM clients WHERE id = ?'
      ).bind(clientId).first();
      if (!c) return jsonResp({ ok: false }, 200, origin);

      const { results: visitRows } = await env.DB.prepare(
        `SELECT visit_date, duration, provider_name, services, internal_notes
         FROM visits WHERE client_id = ? ORDER BY visit_date DESC, id DESC`
      ).bind(clientId).all();

      return jsonResp({
        ok: true,
        client: {
          id: c.id,
          fullName: c.full_name,
          familyEmail: c.family_email,
          address: c.address,
          careTier: c.care_tier,
          careTierNotes: c.care_tier_notes,
        },
        visits: visitRows.map(v => ({
          visitDate: v.visit_date,
          duration: v.duration,
          providerName: v.provider_name,
          services: v.services,
          internalNotes: v.internal_notes,
        })),
      }, 200, origin);
    }

    // ── Create client ───────────────────────────────────────────────
    if (pathname === '/client-create') {
      const session = await getSession(env, body.token);
      if (!session) return jsonResp({ ok: false, error: 'unauthorized' }, 401, origin);

      const fullName    = String(body.fullName || '').trim();
      const familyEmail = String(body.familyEmail || '').trim();
      if (!fullName || !familyEmail) {
        return jsonResp({ ok: false, error: 'missing_fields' }, 400, origin);
      }

      const careTier      = session.role === 'Owner' ? (body.careTier || 'Standard') : 'Standard';
      const careTierNotes = session.role === 'Owner' ? (body.careTierNotes || '') : '';
      const address       = body.address || '';

      const result = await env.DB.prepare(
        `INSERT INTO clients (full_name, family_email, address, care_tier, care_tier_notes)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(fullName, familyEmail, address, careTier, careTierNotes).run();

      return jsonResp({ ok: true, client: { id: result.meta.last_row_id } }, 200, origin);
    }

    // ── Update client (Owner only) ──────────────────────────────────
    if (pathname === '/client-update') {
      const session = await getSession(env, body.token);
      if (!session) return jsonResp({ ok: false, error: 'unauthorized' }, 401, origin);
      if (session.role !== 'Owner') return jsonResp({ ok: false, error: 'forbidden' }, 200, origin);

      await env.DB.prepare(
        `UPDATE clients SET full_name = ?, family_email = ?, address = ?, care_tier = ?, care_tier_notes = ?
         WHERE id = ?`
      ).bind(
        String(body.fullName || '').trim(),
        String(body.familyEmail || '').trim(),
        body.address || '',
        body.careTier || 'Standard',
        body.careTierNotes || '',
        Number(body.clientId)
      ).run();

      return jsonResp({ ok: true }, 200, origin);
    }

    // ── Delete client (Owner only, soft delete) ─────────────────────
    if (pathname === '/client-delete') {
      const session = await getSession(env, body.token);
      if (!session) return jsonResp({ ok: false, error: 'unauthorized' }, 401, origin);
      if (session.role !== 'Owner') return jsonResp({ ok: false, error: 'forbidden' }, 200, origin);

      await env.DB.prepare('UPDATE clients SET active = 0 WHERE id = ?').bind(Number(body.clientId)).run();
      return jsonResp({ ok: true }, 200, origin);
    }

    // ── Send signed visit record + log visit ────────────────────────
    if (pathname === '/send-visit') {
      const session = await getSession(env, body.token);
      if (!session) return jsonResp({ ok: false, error: 'unauthorized' }, 401, origin);

      const { visitData, providerSigDataUrl, clientSigDataUrl, clientId } = body;
      if (!visitData || !providerSigDataUrl || !clientSigDataUrl) {
        return jsonResp({ ok: false, error: 'Missing required fields' }, 400, origin);
      }

      async function uploadSig(dataUrl) {
        const base64 = dataUrl.split(',')[1];
        const form   = new FormData();
        form.append('key',   env.IMGBB_KEY);
        form.append('image', base64);
        const res  = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
        const data = await res.json();
        if (!data.success) throw new Error('ImgBB upload failed: ' + JSON.stringify(data));
        return data.data.url;
      }

      let providerSigUrl, clientSigUrl;
      try {
        [providerSigUrl, clientSigUrl] = await Promise.all([
          uploadSig(providerSigDataUrl),
          uploadSig(clientSigDataUrl),
        ]);
      } catch (err) {
        return jsonResp({ ok: false, error: 'Signature upload failed — ' + err.message }, 502, origin);
      }

      await env.DB.prepare(
        `INSERT INTO visits (client_id, provider_name, provider_role, visit_date, duration, services, notes, internal_notes, provider_sig_url, client_sig_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        Number(clientId),
        visitData.providerName,
        visitData.providerRole,
        visitData.date,
        visitData.duration,
        visitData.services,
        visitData.notes,
        visitData.internalNotes || '',
        providerSigUrl,
        clientSigUrl
      ).run();

      const waveRow = visitData.wave
        ? `<tr><td style="padding:8px 28px 24px;"><a href="${visitData.wave}" style="display:inline-block;background:#f0a500;color:#1a3a5c;font-weight:700;padding:13px 28px;border-radius:8px;text-decoration:none;font-size:15px;">Pay Invoice via Wave →</a></td></tr>`
        : `<tr><td style="padding:4px 28px 24px;font-size:13px;color:#5a6a7e;">An invoice will be sent separately via Wave.</td></tr>`;

      const notes = (visitData.notes || '').replace(/\n/g, '<br>');

      const htmlContent = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;background:#f0f4f8;padding:24px;"><div style="background:linear-gradient(135deg,#1a3a5c,#2c5f8a);border-radius:12px 12px 0 0;padding:28px 32px;"><div style="font-size:20px;font-weight:900;color:white;font-family:Georgia,serif;margin-bottom:4px;">⚓ Steadfast Senior Services</div><div style="font-size:13px;color:#b8d4f0;">Signed Visit Completion Record</div></div><div style="background:white;border-radius:0 0 12px 12px;"><table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 28px 8px;"><h2 style="margin:0;font-family:Georgia,serif;color:#1a3a5c;font-size:20px;">Visit Completed — ${visitData.client}</h2></td></tr><tr><td style="padding:16px 28px;"><table cellpadding="0" cellspacing="0" width="100%" style="background:#f7faff;border:1px solid #dde8f5;border-radius:8px;"><tr><td style="padding:12px 16px;font-size:12px;font-weight:700;color:#5a6a7e;text-transform:uppercase;letter-spacing:1px;width:110px;">Provider</td><td style="padding:12px 16px;font-size:14px;color:#2d3748;">${visitData.providerName} <span style="font-size:12px;color:#5a6a7e;">(${visitData.providerRole})</span></td></tr><tr style="border-top:1px solid #dde8f5;"><td style="padding:12px 16px;font-size:12px;font-weight:700;color:#5a6a7e;text-transform:uppercase;letter-spacing:1px;">Date</td><td style="padding:12px 16px;font-size:14px;color:#2d3748;">${visitData.dateFormatted}</td></tr><tr style="border-top:1px solid #dde8f5;"><td style="padding:12px 16px;font-size:12px;font-weight:700;color:#5a6a7e;text-transform:uppercase;letter-spacing:1px;">Duration</td><td style="padding:12px 16px;font-size:14px;color:#2d3748;">${visitData.duration}</td></tr><tr style="border-top:1px solid #dde8f5;"><td style="padding:12px 16px;font-size:12px;font-weight:700;color:#5a6a7e;text-transform:uppercase;letter-spacing:1px;">Services</td><td style="padding:12px 16px;font-size:14px;color:#2d3748;">${visitData.services}</td></tr></table></td></tr><tr><td style="padding:8px 28px 20px;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#2c5f8a;margin-bottom:10px;">Provider Notes for Family</div><div style="background:#f7faff;border-left:3px solid #2c5f8a;padding:14px 18px;border-radius:0 8px 8px 0;font-size:14px;color:#2d3748;line-height:1.7;">${notes}</div></td></tr><tr><td style="padding:0 28px 20px;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#2c5f8a;margin-bottom:10px;">Provider Signature</div><img src="${providerSigUrl}" style="max-width:300px;border:1px solid #dde8f5;border-radius:6px;display:block;background:#fafbfd;"/></td></tr><tr><td style="padding:0 28px 8px;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#2c5f8a;margin-bottom:10px;">Client Confirmation Signature</div><img src="${clientSigUrl}" style="max-width:300px;border:1px solid #dde8f5;border-radius:6px;display:block;background:#fafbfd;"/><div style="font-size:12px;color:#5a6a7e;margin-top:8px;">Client confirmed services were received and completed to their satisfaction.</div></td></tr>${waveRow}<tr><td style="padding:20px 28px;background:#f7faff;border-top:1px solid #dde8f5;border-radius:0 0 12px 12px;"><div style="font-size:13px;font-weight:700;color:#1a3a5c;margin-bottom:4px;">Steadfast Senior Services</div><div style="font-size:12px;color:#5a6a7e;line-height:1.8;">(781) 929-4623 &nbsp;|&nbsp; steadfastseniorservices@gmail.com<br>Serving all of Massachusetts &nbsp;·&nbsp; CORI Checked &nbsp;·&nbsp; Fully Insured</div></td></tr></table></div></div>`;

      scheduleBackground(async () => {
        const emailRes = await fetchWithTimeout('https://api.emailjs.com/api/v1.0/email/send', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            service_id:  env.EMAILJS_SERVICE_ID,
            template_id: env.EMAILJS_TEMPLATE_ID,
            user_id:     env.EMAILJS_PUBLIC_KEY,
            accessToken: env.EMAILJS_PRIVATE_KEY,
            template_params: {
              to_email:      visitData.email,
              subject:       visitData.subject,
              client_name:   visitData.client,
              provider_name: visitData.providerName,
              visit_date:    visitData.dateFormatted,
              duration:      visitData.duration,
              services:      visitData.services,
              family_notes:  visitData.notes,
              provider_sig:  providerSigUrl,
              client_sig:    clientSigUrl,
              html_content:  htmlContent,
              wave_text:     visitData.wave ? 'Pay invoice: ' + visitData.wave : 'An invoice will be sent separately via Wave.',
            },
          }),
        }, 15000);

        if (!emailRes.ok) {
          const errText = await emailRes.text();
          console.error('Visit email send failed:', errText);
        }
      }, ctx);

      return jsonResp({ ok: true }, 200, origin);
    }

    // ── Support chat ──────────────────────────────────────────────
    if (pathname === '/chat') {
      const message = String(body.message || '').trim();
      if (!message) return jsonResp({ ok: false, error: 'empty_message' }, 400, origin);
      if (message.length > 2000) return jsonResp({ ok: false, error: 'message_too_long' }, 400, origin);

      const ip     = request.headers.get('CF-Connecting-IP') || 'unknown';
      const ipHash = await sha256Hex(`${ip}:${env.IP_HASH_SALT || 'steadfast-chat'}`);

      let sessionId = String(body.sessionId || '');
      let session = sessionId
        ? await env.DB.prepare('SELECT id, message_count FROM chat_sessions WHERE id = ?').bind(sessionId).first()
        : null;

      if (!session) {
        const dailyCount = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM chat_sessions WHERE ip_hash = ? AND created_at >= datetime('now', '-1 day')`
        ).bind(ipHash).first();

        if (dailyCount.count >= 15) {
          return jsonResp({
            ok: true,
            sessionId: sessionId || crypto.randomUUID(),
            reply: "We're seeing a lot of messages from your connection today — please call or text us directly at (781) 929-4623, or email steadfastseniorservices@gmail.com.",
          }, 200, origin);
        }

        sessionId = crypto.randomUUID();
        await env.DB.prepare('INSERT INTO chat_sessions (id, ip_hash) VALUES (?, ?)').bind(sessionId, ipHash).run();
        session = { id: sessionId, message_count: 0 };
      }

      if (session.message_count >= 40) {
        return jsonResp({
          ok: true,
          sessionId,
          reply: "We've covered a lot of ground in this chat! For anything further, please call or text us at (781) 929-4623, or email steadfastseniorservices@gmail.com and we'll pick up right where we left off.",
        }, 200, origin);
      }

      const kbRow = await env.DB.prepare('SELECT content FROM kb_content WHERE id = 1').first();
      const kbContent = kbRow?.content ||
        'No knowledge base content is configured yet. Tell the visitor to call or text (781) 929-4623 or email steadfastseniorservices@gmail.com, and call capture_lead with whatever contact info they give.';

      const { results: priorRows } = await env.DB.prepare(
        'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id ASC'
      ).bind(sessionId).all();

      const messages = priorRows.map((r) => ({ role: r.role, content: r.content }));
      messages.push({ role: 'user', content: message });

      const systemText = 'You are the support chat assistant embedded on the Steadfast Senior Services website. ' +
        'Speak warmly and briefly, like a live chat agent — not an email. Use the knowledge base below as your ' +
        'only source of facts; do not invent policy, pricing, or scheduling details. Follow the "How to use this ' +
        `document" instructions at the end of the knowledge base.\n\n${kbContent}`;

      const nowEastern = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long',
        day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
      }).format(new Date());

      const requestArgs = {
        // Stable KB block stays cached; the current-time block is appended
        // AFTER the cache breakpoint so it changes every request without
        // invalidating the cached (expensive) prefix.
        system: [
          { type: 'text', text: systemText, cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: `Current date/time in Massachusetts (Eastern): ${nowEastern}.` },
        ],
        tools: [CAPTURE_LEAD_TOOL],
      };

      let claudeResp;
      try {
        claudeResp = await callClaude(env, { ...requestArgs, messages });
      } catch (err) {
        console.error('Claude call failed:', err);
        return jsonResp({ ok: false, error: 'chat_unavailable' }, 502, origin);
      }

      let replyText;
      const toolUse = claudeResp.content.find((b) => b.type === 'tool_use' && b.name === 'capture_lead');

      if (toolUse) {
        const input = toolUse.input || {};
        await env.DB.prepare(
          'INSERT INTO chat_leads (session_id, category, name, contact, question, preferred_time) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(sessionId, input.category || 'general_inquiry', input.name || '', input.contact || '', input.question || '', input.preferred_time || '').run();

        scheduleBackground(sendLeadEmail(env, { sessionId, ...input }), ctx);

        const followUpMessages = [
          ...messages,
          { role: 'assistant', content: claudeResp.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Lead captured and the team has been notified by email.' }] },
        ];

        try {
          const followUpResp = await callClaude(env, { ...requestArgs, messages: followUpMessages });
          replyText = (followUpResp.content.find((b) => b.type === 'text') || {}).text ||
            "Thanks — I've passed this along and someone will reach out soon.";
        } catch (err) {
          console.error('Claude follow-up call failed:', err);
          replyText = "Thanks — I've passed this along and someone will reach out soon.";
        }
      } else {
        replyText = (claudeResp.content.find((b) => b.type === 'text') || {}).text ||
          "Sorry, I didn't catch that — could you rephrase?";
      }

      await env.DB.batch([
        env.DB.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').bind(sessionId, 'user', message),
        env.DB.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').bind(sessionId, 'assistant', replyText),
        env.DB.prepare('UPDATE chat_sessions SET message_count = message_count + 1 WHERE id = ?').bind(sessionId),
      ]);

      return jsonResp({ ok: true, sessionId, reply: replyText }, 200, origin);
    }

    return jsonResp({ ok: false, error: 'Not found' }, 404, origin);
  },
};
