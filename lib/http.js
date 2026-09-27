// Small helpers shared by the /api functions.

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// Optional shared passcode so strangers who find the URL can't run up the
// Anthropic bill. Set APP_PASSCODE in the hosting environment to enable it.
export function checkPasscode(request) {
  const expected = process.env.APP_PASSCODE;
  if (!expected) return null;
  if (request.headers.get("x-passcode") === expected) return null;
  return json({ error: "passcode", message: "Enter the app passcode." }, 401);
}

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
