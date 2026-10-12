'use client';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useEffect } from 'react';
import type { Stop } from './Tracker';
import 'leaflet/dist/leaflet.css';
import { googleMapsUrl } from '../lib/maps';

const pinIcon = new L.Icon({ iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png', iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png', shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png', iconSize: [25,41], iconAnchor: [12,41], popupAnchor: [1,-34], shadowSize: [41,41] });
function FitStops({ stops }: { stops: Stop[] }) { const map = useMap(); useEffect(() => { if (stops.length === 1) map.setView([stops[0].lat, stops[0].lng], 14); else if (stops.length > 1) map.fitBounds(stops.map(s => [s.lat, s.lng] as [number,number]), { padding: [36,36], maxZoom: 14 }); }, [stops, map]); return null; }
export default function MapView({ stops, onComplete }: { stops: Stop[]; onComplete: (id: string) => void }) {
  return <MapContainer center={[45.5019,-73.5674]} zoom={11} scrollWheelZoom className="map-canvas"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" /> <FitStops stops={stops} />{stops.map(stop => <Marker key={stop.id} position={[stop.lat,stop.lng]} icon={pinIcon}><Popup><strong>{stop.name || 'Delivery stop'}</strong><br />{stop.address}<br /><a href={googleMapsUrl(stop.address)} target="_blank" rel="noreferrer">Navigate in Google Maps ↗</a><br /><button className="popup-complete" onClick={() => onComplete(stop.id)}>Mark complete</button></Popup></Marker>)}</MapContainer>
}
