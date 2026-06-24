import { createApp } from './http/app.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const app = createApp();

app.listen(port, () => {
  console.log(`WDTT Fleet Manager listening on ${port}`);
});
