/**
 * Teléfono de México: acepta espacios, guiones y un +52 al principio; lo guarda como 10
 * dígitos (el primero de 2 a 9). Rechaza todo lo demás (paréntesis, puntos, extensiones,
 * otros países, el "1" antiguo de los celulares). Devuelve `undefined` si no es válido.
 */
export function normalizeMexicanPhone(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const compact = input.trim().replace(/[ -]/g, '');
  const match = /^(?:\+52)?([2-9]\d{9})$/.exec(compact);
  return match?.[1];
}

/**
 * Enlace de WhatsApp para que el aprobador le escriba a la persona: https://wa.me/52 + 10
 * dígitos y un mensaje inicial en español, codificado. Sin mapas ni redes sociales.
 * Solo acepta un teléfono ya normalizado (10 dígitos).
 */
export function whatsappUrl(
  telefono10: string,
  nombre: string,
  nombreNegocio: string,
): string {
  if (!/^[2-9]\d{9}$/.test(telefono10)) {
    throw new Error('whatsappUrl needs a normalized 10-digit phone');
  }
  const message = `Hola ${nombre}, soy del equipo de La Marchanta. Vi tu solicitud para "${nombreNegocio}" y quiero confirmar unos datos.`;
  return `https://wa.me/52${telefono10}?text=${encodeURIComponent(message)}`;
}
