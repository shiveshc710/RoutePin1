"use client";

import dynamic from "next/dynamic";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserMultiFormatReader } from "@zxing/browser";
import { googleMapsUrl } from "../lib/maps";

export type Stop = {
  id: string;
  name: string;
  address: string;
  barcode: string;
  lat: number;
  lng: number;
  createdAt: number;
};

type FedExDetails = {
  address: string;
  name: string;
  postalCode: string;
  weight: string;
  references: string[];
};

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="map-loading">Preparing your map…</div>,
});

const STORAGE_KEY = "routepin-stops-v1";

/**
 * Parse the FedEx structured barcode payload.
 * Separators include:
 * GS = \x1d
 * RS = \x1e
 * FS = \x1c
 */
function parseFedExPayload(raw: string): FedExDetails | null {
  if (!raw.includes("[)>")) return null;

  const fields = raw
    .split(/[\x1d\x1e\x1c]/)
    .map((value) => value.trim())
    .filter(Boolean);

  const postalField = fields.find((value) =>
    /^02[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(value),
  );

  const postalCode = postalField
    ? postalField
        .slice(2)
        .replace(/\s+/g, "")
        .toUpperCase()
        .replace(/^(.{3})(.{3})$/, "$1 $2")
    : "";

  const markerIndex = fields.findIndex((value) => value === "N");

  let address = "";
  let name = "";

  if (markerIndex >= 0) {
    const afterMarker = fields.slice(markerIndex + 1);

    const street = afterMarker[0] ?? "";
    const city = afterMarker[1] ?? "";
    const province = afterMarker[2] ?? "";
    const recipient = afterMarker[3] ?? "";

    if (street && city && /^[A-Z]{2}$/i.test(province) && recipient) {
      address = [
        street,
        city,
        `${province.toUpperCase()}${postalCode ? ` ${postalCode}` : ""}`,
        "Canada",
      ].join(", ");

      name = recipient;
    }
  }

  const weight =
    fields.find((value) => /^\d+(?:\.\d+)?\s?(?:LB|KG)$/i.test(value)) ?? "";

  const references = fields.filter((value) =>
    /^(?:10Z|12Z|18Z|31Z|32Z|34Z)/i.test(value),
  );

  // Keep useful decoded package details even when address extraction fails.
  if (!address && !weight && references.length === 0) {
    return null;
  }

  return { address, name, postalCode, weight, references };
}

export default function Tracker() {
  const [stops, setStops] = useState<Stop[]>([]);
  const [completed, setCompleted] = useState<Stop[]>([]);
  const [barcode, setBarcode] = useState("");
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const hasScannedRef = useRef(false);

  // Restore stops saved on this device.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);

      if (saved) {
        const parsed = JSON.parse(saved);
        setStops(parsed.stops || []);
        setCompleted(parsed.completed || []);
      }
    } catch {
      // Ignore malformed local data.
    }
  }, []);

  // Persist active and completed stops.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ stops, completed }));
    } catch {
      // Storage may be unavailable.
    }
  }, [stops, completed]);

  const stopScanner = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    hasScannedRef.current = true;
    setScannerOpen(false);
  }, []);

  useEffect(() => {
    return () => {
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, []);

  // Start a PDF417-first camera scanner.
  const scanBarcode = async () => {
    setMessage("");
    hasScannedRef.current = false;
    setScannerOpen(true);

    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");

      const hints = new Map<DecodeHintType, unknown>();

      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.PDF_417,
        BarcodeFormat.CODE_128,
        BarcodeFormat.DATA_MATRIX,
        BarcodeFormat.QR_CODE,
      ]);

      const reader = new BrowserMultiFormatReader(hints, {
        delayBetweenScanAttempts: 250,
      });
      readerRef.current = reader;

      const devices = await BrowserMultiFormatReader.listVideoInputDevices();

      if (!devices.length) {
        throw new Error(
          "No camera found. Check your device or enter the barcode manually.",
        );
      }

      const preferred = devices.find((device) =>
        /back|rear|environment/i.test(device.label),
      );

      // Wait briefly for React to mount the camera preview.
      let video = videoRef.current;

      for (let attempt = 0; !video && attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        video = videoRef.current;
      }

      if (!video) {
        throw new Error("Camera preview could not be initialized.");
      }

      controlsRef.current = await reader.decodeFromConstraints(
        {
          audio: false,
          video: {
            deviceId: preferred ? { exact: preferred.deviceId } : undefined,
            facingMode: preferred ? undefined : { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        },
        video,
        (result) => {
          if (!result || hasScannedRef.current) return;

          hasScannedRef.current = true;

          const raw = result.getText();
          const format = String(result.getBarcodeFormat());
          const parsed = parseFedExPayload(raw);

          setBarcode(raw);

          if (parsed) {
            if (parsed.address) setAddress(parsed.address);
            if (parsed.name) setName(parsed.name);

            const extraDetails = [
              parsed.postalCode && `Postal code: ${parsed.postalCode}`,
              parsed.weight && `Weight: ${parsed.weight}`,
              parsed.references.length > 0 &&
                `References: ${parsed.references.join(", ")}`,
            ]
              .filter(Boolean)
              .join(" · ");

            setMessage(
              `${format} barcode decoded. ${
                parsed.address
                  ? "Address extracted. Confirm it before adding the stop."
                  : "Package details found, but enter the delivery address manually."
              }${extraDetails ? ` ${extraDetails}` : ""}`,
            );
          } else {
            setMessage(
              `${format} barcode decoded, but the FedEx address format was not recognized. The decoded data has been captured; enter the delivery address manually.`,
            );
          }

          controlsRef.current?.stop();
          controlsRef.current = null;
          setScannerOpen(false);
        },
      );
    } catch (error) {
      controlsRef.current?.stop();
      controlsRef.current = null;
      setScannerOpen(false);

      setMessage(
        error instanceof Error
          ? `Camera error: ${error.message}`
          : "Could not start the camera. Check camera permissions and try again.",
      );
    }
  };

  const addStop = async (e: React.FormEvent) => {
    e.preventDefault();

    const parsed = parseFedExPayload(barcode);
    const destination = address.trim() || parsed?.address || "";

    if (!destination) {
      setMessage(
        "No delivery address was detected. Enter the complete address manually.",
      );
      return;
    }

    setBusy(true);
    setMessage("Checking address…");

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(destination)}`,
        {
          headers: { "Accept-Language": "en-CA,en" },
        },
      );

      if (!response.ok) {
        throw new Error("Address lookup failed. Please try again.");
      }

      const results = await response.json();

      if (!results.length) {
        throw new Error(
          "Address not found. Check the street, city, province, and postal code.",
        );
      }

      const hit = results[0];

      const stop: Stop = {
        id: crypto.randomUUID(),
        name: name.trim() || parsed?.name || "",
        address: hit.display_name || destination,
        barcode: barcode.trim(),
        lat: Number(hit.lat),
        lng: Number(hit.lon),
        createdAt: Date.now(),
      };

      if (stop.barcode && stops.some((s) => s.barcode === stop.barcode)) {
        throw new Error("That barcode is already on your active stop list.");
      }

      setStops((current) => [stop, ...current]);
      setAddress("");
      setBarcode("");
      setName("");
      setMessage("Stop added to your map.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not add this stop.",
      );
    } finally {
      setBusy(false);
    }
  };

  const completeStop = (id: string) => {
    const stop = stops.find((s) => s.id === id);
    if (!stop) return;

    setStops((current) => current.filter((s) => s.id !== id));
    setCompleted((current) => [stop, ...current]);
    setMessage("Delivery marked complete.");
  };

  const undoStop = (id: string) => {
    const stop = completed.find((s) => s.id === id);
    if (!stop) return;

    setCompleted((current) => current.filter((s) => s.id !== id));
    setStops((current) => [stop, ...current]);
  };

  const clearDay = () => {
    if (
      !confirm(
        "Clear all active and completed stops from this device? This cannot be undone.",
      )
    ) {
      return;
    }

    setStops([]);
    setCompleted([]);
    setMessage("Route cleared.");
  };

  const progress = useMemo(
    () =>
      stops.length + completed.length
        ? Math.round(
            (completed.length / (stops.length + completed.length)) * 100,
          )
        : 0,
    [stops.length, completed.length],
  );

  return (
    <main className="app-shell">
      {/* Camera alignment styles are included here so no separate CSS edit is required. */}
      <style jsx>{`
        .camera-box {
          margin-top: 14px;
          overflow: hidden;
          border: 1px solid #dce4eb;
          border-radius: 14px;
          background: #101820;
        }

        .camera-preview {
          position: relative;
          width: 100%;
          aspect-ratio: 4 / 3;
          overflow: hidden;
          background: #101820;
        }

        .camera-preview video {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .scan-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          background: rgba(0, 0, 0, 0.15);
        }

        .scan-frame {
          position: relative;
          width: 90%;
          height: 44%;
          border: 1px dashed rgba(255, 255, 255, 0.8);
          border-radius: 8px;
        }

        .corner {
          position: absolute;
          width: 24px;
          height: 24px;
          border-color: #32d583;
          border-style: solid;
        }

        .top-left {
          top: -2px;
          left: -2px;
          border-width: 4px 0 0 4px;
          border-radius: 7px 0 0 0;
        }

        .top-right {
          top: -2px;
          right: -2px;
          border-width: 4px 4px 0 0;
          border-radius: 0 7px 0 0;
        }

        .bottom-left {
          bottom: -2px;
          left: -2px;
          border-width: 0 0 4px 4px;
          border-radius: 0 0 0 7px;
        }

        .bottom-right {
          right: -2px;
          bottom: -2px;
          border-width: 0 4px 4px 0;
          border-radius: 0 0 7px 0;
        }

        .scan-line {
          position: absolute;
          top: 50%;
          left: 4%;
          width: 92%;
          height: 2px;
          background: #32d583;
          box-shadow: 0 0 8px rgba(50, 213, 131, 0.8);
        }

        .scan-instructions {
          margin: 0;
          padding: 12px;
          color: #fff;
          font-size: 13px;
          line-height: 1.5;
          text-align: center;
        }
      `}</style>

      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark">R</span>
          <span>
            route<span className="brand-accent">pin</span>
            <small>DELIVERY STOP TRACKER</small>
          </span>
        </a>

        <div className="topbar-right">
          <span className="privacy-dot" /> Saved on this device{" "}
          <button
            className="icon-button"
            title="Clear route"
            onClick={clearDay}
          >
            ↺
          </button>
        </div>
      </header>

      <section className="welcome">
        <div>
          <div className="eyebrow">YOUR ROUTE, AT A GLANCE</div>
          <h1>
            Make every stop <span>count.</span>
          </h1>
          <p>Scan a package, pin the address, and keep your day moving.</p>
        </div>
        <div className="date-chip">● &nbsp; LIVE ROUTE</div>
      </section>

      <section className="stats-grid">
        <div className="stat-card active-stat">
          <div className="stat-label">
            REMAINING STOPS <span>↗</span>
          </div>
          <div className="stat-number">
            {stops.length.toString().padStart(2, "0")}
          </div>
          <div className="stat-foot">Deliveries left to complete</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">COMPLETED</div>
          <div className="stat-number">
            {completed.length.toString().padStart(2, "0")}
          </div>
          <div className="stat-foot">Stops finished today</div>
        </div>

        <div className="stat-card progress-card">
          <div className="stat-label">ROUTE PROGRESS</div>
          <div className="progress-row">
            <div className="stat-number">
              {progress}
              <small>%</small>
            </div>
            <div
              className="progress-ring"
              style={{
                background: `conic-gradient(#f5a623 ${progress * 3.6}deg, #e8edf1 0deg)`,
              }}
            >
              <div />
            </div>
          </div>
          <div className="progress-track">
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="stat-foot">Keep up the good work</div>
        </div>
      </section>

      <section className="workspace">
        <div className="map-panel">
          <div className="panel-heading">
            <div>
              <h2>Stop map</h2>
              <p>
                {stops.length
                  ? `${stops.length} active ${stops.length === 1 ? "stop" : "stops"} on your route`
                  : "Your scanned stops will appear here"}
              </p>
            </div>
            <span className="map-legend">
              <i /> Active stop
            </span>
          </div>

          <div className="map-wrap">
            <MapView stops={stops} onComplete={completeStop} />
            {!stops.length && (
              <div className="map-empty">
                <div className="empty-icon">⌖</div>
                <strong>Your route starts here</strong>
                <span>Add your first package to see it on the map.</span>
              </div>
            )}
          </div>

          <div className="map-footer">
            <span>Map data © OpenStreetMap contributors</span>
            <span>Tap a pin for directions</span>
          </div>
        </div>

        <aside className="side-panel">
          <div className="panel-heading side-heading">
            <div>
              <h2>Add a stop</h2>
              <p>Scan the barcode or enter details</p>
            </div>
            <span className="step-badge">01</span>
          </div>

          <button
            type="button"
            className={`scan-button ${scannerOpen ? "scanning" : ""}`}
            onClick={scannerOpen ? stopScanner : scanBarcode}
          >
            <span className="scan-icon">▦</span>
            <span>
              <strong>
                {scannerOpen ? "Stop scanning" : "Scan package barcode"}
              </strong>
              <small>
                {scannerOpen ? "Camera is active" : "Use your phone camera"}
              </small>
            </span>
            <span className="button-arrow">{scannerOpen ? "×" : "↗"}</span>
          </button>

          {scannerOpen && (
            <div className="camera-box">
              <div className="camera-preview">
                <video ref={videoRef} autoPlay muted playsInline />

                <div className="scan-overlay" aria-hidden="true">
                  <div className="scan-frame">
                    <span className="corner top-left" />
                    <span className="corner top-right" />
                    <span className="corner bottom-left" />
                    <span className="corner bottom-right" />
                    <span className="scan-line" />
                  </div>
                </div>
              </div>

              <p className="scan-instructions">
                Align the entire PDF417 barcode inside the frame. Keep your
                phone steady, avoid glare, and make sure the bars are sharp.
              </p>
            </div>
          )}

          <div className="or-divider">
            <span />
            OR ENTER MANUALLY
            <span />
          </div>

          <form className="stop-form" onSubmit={addStop}>
            <label>
              BARCODE / TRACKING NUMBER <span>OPTIONAL</span>
              <input
                value={barcode}
                onChange={(e) => {
                  const value = e.target.value;
                  setBarcode(value);

                  const parsed = parseFedExPayload(value);

                  if (parsed) {
                    if (parsed.address) setAddress(parsed.address);
                    if (parsed.name) setName(parsed.name);

                    setMessage(
                      parsed.address
                        ? "FedEx address details detected. Confirm the address before adding the stop."
                        : "FedEx package details detected. Enter the delivery address manually.",
                    );
                  }
                }}
                placeholder="Scan or paste barcode data"
              />
            </label>

            <label>
              RECIPIENT / STOP NAME <span>OPTIONAL</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Smith residence"
              />
            </label>

            <label>
              DELIVERY ADDRESS <b>*</b>
              <textarea
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street address, city, province, postal code"
                rows={3}
              />
            </label>

            <button className="add-button" disabled={busy}>
              {busy ? (
                <>
                  <span className="spinner" /> Finding address…
                </>
              ) : (
                <>
                  <span>＋</span> Add stop to map{" "}
                  <span className="button-arrow">↗</span>
                </>
              )}
            </button>
          </form>

          {message && (
            <div
              className={`message ${
                /failed|could not|not found|already|no camera|camera error/i.test(
                  message,
                )
                  ? "message-error"
                  : ""
              }`}
              role="status"
            >
              {message}
            </div>
          )}

          <div className="privacy-note">
            <span>ⓘ</span>
            <p>
              PDF417 and other supported barcodes are decoded in your browser.
              Always confirm the delivery address before adding a stop.
            </p>
          </div>
        </aside>
      </section>

      <section className="stops-section">
        <div className="section-heading">
          <div>
            <div className="eyebrow">YOUR DELIVERY LIST</div>
            <h2>
              Stops to make <span className="count-pill">{stops.length}</span>
            </h2>
          </div>

          <button
            className="text-button"
            onClick={() => setShowCompleted((value) => !value)}
          >
            {showCompleted
              ? "Hide completed"
              : `View completed (${completed.length})`}{" "}
            <span>→</span>
          </button>
        </div>

        {stops.length ? (
          <div className="stop-list">
            {stops.map((stop, index) => (
              <article className="stop-item" key={stop.id}>
                <div className="stop-index">
                  {String(stops.length - index).padStart(2, "0")}
                </div>

                <div className="stop-details">
                  <strong>
                    {stop.name || `Delivery stop ${stops.length - index}`}
                  </strong>
                  <span>{stop.address}</span>
                  {stop.barcode && <small>Barcode: {stop.barcode}</small>}
                </div>

                <a
                  className="navigate-button"
                  href={googleMapsUrl(stop.address)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Navigate <span>↗</span>
                </a>

                <button
                  className="complete-button"
                  onClick={() => completeStop(stop.id)}
                  title="Mark this delivery complete"
                >
                  ✓
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="list-empty">
            <span>✓</span>
            <div>
              <strong>All caught up</strong>
              <p>
                No active stops. Scan a package or add an address to get
                started.
              </p>
            </div>
          </div>
        )}

        {showCompleted && (
          <div className="completed-list">
            <div className="completed-title">COMPLETED DELIVERIES</div>

            {completed.length ? (
              completed.map((stop) => (
                <article className="stop-item completed-item" key={stop.id}>
                  <div className="stop-index done">✓</div>

                  <div className="stop-details">
                    <strong>{stop.name || "Delivery stop"}</strong>
                    <span>{stop.address}</span>
                    {stop.barcode && <small>Barcode: {stop.barcode}</small>}
                  </div>

                  <button
                    className="undo-button"
                    onClick={() => undoStop(stop.id)}
                  >
                    Undo
                  </button>
                </article>
              ))
            ) : (
              <p className="no-completed">No completed deliveries yet.</p>
            )}
          </div>
        )}
      </section>

      <footer className="footer">
        <span>
          ROUTEPIN <b>•</b> BUILT FOR THE ROAD
        </span>
        <span>
          Stops are stored locally on this device. Don&apos;t enter unnecessary
          customer information.
        </span>
      </footer>
    </main>
  );
}
