import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'RoutePin — Delivery Stop Tracker', description: 'Scan package barcodes, organize delivery stops, and navigate with Google Maps.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
