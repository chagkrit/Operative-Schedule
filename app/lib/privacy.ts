// Thai leading vowels are written before the consonant they belong to, so the
// "first letter" of เมืองใจ is เม, not เ.
const THAI_LEADING_VOWELS = new Set(["เ", "แ", "โ", "ใ", "ไ"]);

function surnameInitial(lastName: string) {
  const chars = Array.from(lastName.trim());
  if (chars.length === 0) return "";
  let end = 0;
  while (end < chars.length - 1 && THAI_LEADING_VOWELS.has(chars[end])) end += 1;
  end += 1;
  // Keep combining marks (tone, vowel above/below) so the initial does not render broken.
  while (end < chars.length && /\p{M}/u.test(chars[end])) end += 1;
  return `${chars.slice(0, end).join("").toLocaleUpperCase("en")}.`;
}

/** Full first name + surname reduced to its initial, for on-screen display only. */
export function patientDisplayName(firstName: string, lastName: string) {
  const initial = surnameInitial(lastName);
  return [firstName.trim(), initial].filter(Boolean).join(" ");
}
