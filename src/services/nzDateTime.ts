export function getNZDateTime(): Date{
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
}