function cell(value) {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function toCsv(columns, rows) {
  return [columns, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
