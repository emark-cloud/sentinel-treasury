import type { Metadata, Viewport } from 'next';
import './globals.css';
import { WalletProvider } from '../lib/wallet';

export const metadata: Metadata = {
  title: 'Sentinel Treasury — command center',
  description:
    'Autonomous, self-auditing on-chain treasury manager · Casper Testnet · perceive → decide → act → prove',
};

export const viewport: Viewport = {
  themeColor: '#0a0b0d',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
