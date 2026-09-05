export function normalizeWhatsAppNumber(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

export function isValidWhatsAppNumber(raw: string): boolean {
  const digits = normalizeWhatsAppNumber(raw);
  return digits.length >= 8 && digits.length <= 15;
}

export function buildWhatsAppUrl(rawNumber: string, message: string): string {
  const digits = normalizeWhatsAppNumber(rawNumber);
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
