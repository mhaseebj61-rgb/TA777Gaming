
import { createClient } from '@supabase/supabase-js';

// TA777Gaming browser-side Supabase client.
// Set these in Netlify's build environment:
// VITE_SUPABASE_URL=https://ymudawdtktekrhgtqvxe.supabase.co
// VITE_SUPABASE_PUBLISHABLE_KEY=<publishable/anon key for this same project>

const supabaseUrl = String(
  import.meta.env.VITE_SUPABASE_URL || ''
).trim().replace(/\/$/, '');

const supabaseKey = String(
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || ''
).trim();

export const supabaseConfigured = Boolean(
  supabaseUrl && supabaseKey
);

export const supabaseConfigIssue = !supabaseUrl
  ? 'Missing VITE_SUPABASE_URL in Netlify build environment.'
  : !supabaseKey
    ? 'Missing VITE_SUPABASE_PUBLISHABLE_KEY in Netlify build environment.'
    : !/^https:\/\//i.test(supabaseUrl)
      ? 'VITE_SUPABASE_URL must begin with https://.'
      : null;

if (supabaseConfigIssue) {
  console.error(`[TA777Gaming] ${supabaseConfigIssue}`);
} else {
  try {
    const parsed = new URL(supabaseUrl);

    if (
      !parsed.hostname.endsWith('.supabase.co') &&
      !parsed.hostname.includes('.supabase.')
    ) {
      console.warn(
        '[TA777Gaming] The configured URL does not look like a standard Supabase project URL.'
      );
    }
  } catch {
    console.error(
      '[TA777Gaming] VITE_SUPABASE_URL is not a valid URL.'
    );
  }
}

// Preserve the app's existing import API.
// Never put a service-role or secret key in this browser file.

export const supabase = createClient(
  supabaseUrl || 'https://ymudawdtktekrhgtqvxe.supabase.co',
  supabaseKey || 'MISSING_PUBLISHABLE_KEY',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
    global: {
      fetch: async (input, init) => {
        try {
          return await fetch(input, init);
        } catch (error) {
          const requestUrl =
            typeof input === 'string'
              ? input
              : input?.url || '(unknown URL)';

          console.error(
            '[TA777Gaming] Supabase network request failed.',
            {
              requestUrl,
              message: error?.message || String(error),
              hint:
                'Check the deployed URL, internet/network access, and that the Supabase project is active.',
            }
          );

          throw new Error(
            `Supabase network request failed. URL: ${requestUrl}. ${
              error?.message ||
              'Check connection and Supabase project status.'
            }`
          );
        }
      },
    },
  }
);

export async function testSupabaseConnection() {
  if (!supabaseConfigured) {
    return {
      ok: false,
      message:
        supabaseConfigIssue ||
        'Supabase configuration is missing.',
    };
  }

  try {
    const { error } = await supabase.auth.getSession();

    if (error) {
      return { ok: false, message: error.message };
    }

    return {
      ok: true,
      message: 'Supabase endpoint responded successfully.',
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error?.message || 'Unknown connection error.',
    };
  }
}
