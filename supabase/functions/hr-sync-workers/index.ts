import { withSupabase } from 'npm:@supabase/server@^1';

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export default {
  // This endpoint accepts only the dedicated Supabase secret key named `hr_sync`.
  // The @supabase/server wrapper validates the key from the `apikey` header.
  fetch: withSupabase({ auth: 'secret:hr_sync' }, async (req, ctx) => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Request body must be valid JSON' }, 400);
    }
    if (!Array.isArray(body.rows)) return json({ error: 'rows must be an array' }, 400);
    if (body.rows.length > 20000) return json({ error: 'HR sync batch exceeds 20,000 rows' }, 413);

    const minimumRows = Math.max(0, Number(Deno.env.get('HR_SYNC_MIN_ROWS') ?? '0') || 0);
    const { data, error } = await ctx.supabaseAdmin.rpc('hhd_hr_sync_workers', {
      p_rows: body.rows,
      p_snapshot_complete: body.snapshot_complete === true,
      p_minimum_rows: minimumRows,
      p_checksum: typeof body.checksum === 'string' ? body.checksum : null,
    });

    if (error) {
      await ctx.supabaseAdmin.from('hr_sync_runs').insert({
        source: 'HR_GOOGLE_SHEET', status: 'failed', received_rows: body.rows.length,
        snapshot_complete: body.snapshot_complete === true, error_count: 1,
        completed_at: new Date().toISOString(), initiated_by: 'Apps Script HR sync',
        message: error.message, errors: [{ message: error.message }],
      });
      return json({ error: error.message }, 400);
    }
    return json({ ok: true, result: data });
  }),
};
