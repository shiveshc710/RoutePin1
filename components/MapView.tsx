"use client";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import { useEffect } from "react";
import type { Stop } from "./Tracker";
import "leaflet/dist/leaflet.css";
import { googleMapsUrl } from "../lib/maps";

type Point = { lat: number; lng: number };
const pinIcon = new L.Icon({ iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png", iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png", shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png", iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41] });
const stationIcon = new L.DivIcon({ className: "station-map-pin", html: '<div style="background:#174b87;color:#fff;border:2px solid white;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-weight:800;box-shadow:0 2px 8px #555">S</div>', iconSize: [34, 34], iconAnchor: [17, 17] });
function FitMap({ stops, station, routeGeometry }: { stops: Stop[]; station: Point; routeGeometry: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    const points: [number, number][] = routeGeometry.length ? routeGeometry : [[station.lat, station.lng], ...stops.map(s => [s.lat, s.lng] as [number, number])];
    if (points.length === 1) map.setView(points[0], 13); else if (points.length > 1) map.fitBounds(points, { padding: [36, 36], maxZoom: 14 });
  }, [stops, station, routeGeometry, map]);
  return null;
}
export default function MapView({ stops, onComplete, routeGeometry = [], station, stationAddress }: { stops: Stop[]; onComplete: (id: string) => void; routeGeometry?: [number, number][]; station: Point; stationAddress: string }) {
  return <MapContainer center={[station.lat, station.lng]} zoom={11} scrollWheelZoom className="map-canvas"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" /><FitMap stops={stops} station={station} routeGeometry={routeGeometry} />{routeGeometry.length > 1 && <Polyline positions={routeGeometry} pathOptions={{ color: "#174b87", weight: 5, opacity: 0.8 }} />}<Marker position={[station.lat, station.lng]} icon={stationIcon}><Popup><strong>Start / Finish: FedEx station</strong><br />{stationAddress}<br /><a href={googleMapsUrl(stationAddress)} target="_blank" rel="noreferrer">Navigate to station ↗</a></Popup></Marker>{stops.map((stop, index) => <Marker key={stop.id} position={[stop.lat, stop.lng]} icon={pinIcon}><Popup><strong>{index + 1}. {stop.name || "Delivery stop"}</strong><br />{stop.address}<br /><a href={googleMapsUrl(stop.address)} target="_blank" rel="noreferrer">Navigate in Google Maps ↗</a><br /><button className="popup-complete" onClick={() => onComplete(stop.id)}>Mark complete</button></Popup></Marker>)}</MapContainer>;
}
