const timestamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export const log = {
  info: (msg: string) => console.log(`[${timestamp()}] INFO  ${msg}`),
  warn: (msg: string) => console.log(`[${timestamp()}] WARN  ${msg}`),
  error: (msg: string) => console.error(`[${timestamp()}] ERROR ${msg}`),
  signal: (msg: string) => console.log(msg),
};
