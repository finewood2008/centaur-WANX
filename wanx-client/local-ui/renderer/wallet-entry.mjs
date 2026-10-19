import QRCode from 'qrcode';
import { createWalletView } from './wallet-view.mjs';

window.createWalletView = options => createWalletView({
  ...options,
  qr: payload => QRCode.toDataURL(payload, { width: 240, margin: 3, errorCorrectionLevel: 'M' }),
});
