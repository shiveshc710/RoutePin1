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

  description: string;
};

type FedExDetails = {
  address: string;

  name: string;

  postalCode: string;

  weight: string;

  references: string[];
};

type AddressSuggestion = {
  id: string;

  label: string;

  prediction: any;
};

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,

  loading: () => <div className="map-loading">Preparing your map…</div>,
});

const STORAGE_KEY = "routepin-stops-v1";

declare global {
  interface Window {
    google?: any;

    __routepinGooglePromise?: Promise<any>;
  }
}

/**

 * Loads Google Places once and reuses the in-flight request.

 * Polls for importLibrary rather than assuming script.onload

 * means the Google Maps API is ready.

 */

function loadGooglePlaces(): Promise<any> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Google Places requires a browser."));
  }

  if (window.google?.maps?.importLibrary) {
    return window.google.maps.importLibrary("places");
  }

  if (window.__routepinGooglePromise) {
    return window.__routepinGooglePromise;
  }

  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  if (!key) {
    return Promise.reject(
      new Error("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY."),
    );
  }

  window.__routepinGooglePromise = new Promise((resolve, reject) => {
    let settled = false;

    let timeoutId: number | undefined;

    let pollId: number | undefined;

    const cleanup = () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }

      if (pollId !== undefined) {
        window.clearInterval(pollId);
      }
    };

    const fail = (error: Error) => {
      if (settled) return;

      settled = true;

      cleanup();

      window.__routepinGooglePromise = undefined;

      reject(error);
    };

    const finish = async () => {
      if (settled) return;

      if (!window.google?.maps?.importLibrary) {
        return;
      }

      try {
        const places = await window.google.maps.importLibrary("places");

        if (settled) return;

        settled = true;

        cleanup();

        resolve(places);
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error("Google Places initialization failed."),
        );
      }
    };

    const existingScript = document.querySelector(
      'script[data-routepin-google="true"]',
    ) as HTMLScriptElement | null;

    const script = existingScript ?? document.createElement("script");

    if (!existingScript) {
      script.dataset.routepinGoogle = "true";

      script.src =
        "https\://maps.googleapis.com/maps/api/js" +
        `?key=${encodeURIComponent(key)}` +
        "&v=weekly&loading=async";

      script.async = true;

      script.defer = true;
    }

    timeoutId = window.setTimeout(() => {
      fail(
        new Error(
          "Google Maps timed out. Check the Console for Google Maps API errors.",
        ),
      );
    }, 20000);

    pollId = window.setInterval(() => {
      if (window.google?.maps?.importLibrary) {
        void finish();
      }
    }, 100);

    script.addEventListener(
      "error",

      () => {
        fail(
          new Error(
            "Google Maps script failed to load. Check your API key and website restrictions.",
          ),
        );
      },

      { once: true },
    );

    if (!existingScript) {
      document.head.appendChild(script);
    }

    void finish();
  });

  return window.__routepinGooglePromise;
}

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

  if (!address && !weight && references.length === 0) {
    return null;
  }

  return { address, name, postalCode, weight, references };
}

function normalizeStop(stop: any): Stop {
  return {
    ...stop,

    description: typeof stop.description === "string" ? stop.description : "",

    name: typeof stop.name === "string" ? stop.name : "",

    address: typeof stop.address === "string" ? stop.address : "",

    barcode: typeof stop.barcode === "string" ? stop.barcode : "",
  };
}

export default function Tracker() {
  const [stops, setStops] = useState<Stop[]>([]);

  const [completed, setCompleted] = useState<Stop[]>([]);

  const [barcode, setBarcode] = useState("");

  const [address, setAddress] = useState("");

  const [name, setName] = useState("");

  const [description, setDescription] = useState("");

  const [busy, setBusy] = useState(false);

  const [message, setMessage] = useState("");

  const [scannerOpen, setScannerOpen] = useState(false);

  const [showCompleted, setShowCompleted] = useState(false);

  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);

  const [suggestionsOpen, setSuggestionsOpen] = useState(false);

  const [placesReady, setPlacesReady] = useState(false);

  const [optimizing, setOptimizing] = useState(false);

  const selectedPlaceRef = useRef<{
    address: string;

    lat: number;

    lng: number;
  } | null>(null);

  const placesSessionRef = useRef<any>(null);

  const suggestionRequestRef = useRef(0);

  const videoRef = useRef<HTMLVideoElement>(null);

  const readerRef = useRef<BrowserMultiFormatReader | null>(null);

  const controlsRef = useRef<{ stop: () => void } | null>(null);

  const hasScannedRef = useRef(false);

  const scannerStartingRef = useRef(false);

  // Restore saved stops from local storage.

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);

      if (saved) {
        const parsed = JSON.parse(saved);

        setStops(
          Array.isArray(parsed.stops) ? parsed.stops.map(normalizeStop) : [],
        );

        setCompleted(
          Array.isArray(parsed.completed)
            ? parsed.completed.map(normalizeStop)
            : [],
        );
      }
    } catch {
      // Ignore malformed local data.
    }
  }, []);

  // Persist stop changes.

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ stops, completed }));
    } catch {
      // Storage may be unavailable.
    }
  }, [stops, completed]);

  // Initialize Google Places.

  useEffect(() => {
    let cancelled = false;

    loadGooglePlaces()
      .then(() => {
        if (!cancelled) setPlacesReady(true);
      })

      .catch((error) => {
        console.error("Google Places initialization failed:", error);

        if (!cancelled) {
          setMessage(
            error instanceof Error
              ? error.message
              : "Google Places could not be initialized.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch autocomplete suggestions while typing.

  useEffect(() => {
    const query = address.trim();

    const requestId = ++suggestionRequestRef.current;

    if (
      !placesReady ||
      !suggestionsOpen ||
      query.length < 3 ||
      selectedPlaceRef.current?.address === query
    ) {
      setSuggestions([]);

      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const places = await loadGooglePlaces();

        if (requestId !== suggestionRequestRef.current) {
          return;
        }

        if (!placesSessionRef.current) {
          placesSessionRef.current = new places.AutocompleteSessionToken();
        }

        const response =
          await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: query,

            includedRegionCodes: ["ca"],

            sessionToken: placesSessionRef.current,
          });

        if (requestId !== suggestionRequestRef.current) {
          return;
        }

        setSuggestions(
          (response.suggestions ?? [])

            .filter((item: any) => item.placePrediction)

            .slice(0, 5)

            .map((item: any) => ({
              id: [
                item.placePrediction.placeId,

                item.placePrediction.text?.toString(),
              ].join("-"),

              label: item.placePrediction.text?.toString() ?? "",

              prediction: item.placePrediction,
            })),
        );
      } catch (error) {
        console.error("Google Places autocomplete failed:", error);

        if (requestId === suggestionRequestRef.current) {
          setSuggestions([]);

          setMessage(
            error instanceof Error
              ? `Address suggestions failed: ${error.message}`
              : "Address suggestions could not be loaded.",
          );
        }
      }
    }, 450);

    return () => window.clearTimeout(timer);
  }, [address, placesReady, suggestionsOpen]);

  const selectSuggestion = async (suggestion: AddressSuggestion) => {
    try {
      setBusy(true);

      setMessage("Loading selected address…");

      setSuggestionsOpen(false);

      setSuggestions([]);

      const place = suggestion.prediction.toPlace();

      await place.fetchFields({
        fields: ["formattedAddress", "location"],
      });

      const location = place.location;

      const formattedAddress = place.formattedAddress || suggestion.label;

      if (
        !location ||
        typeof location.lat !== "function" ||
        typeof location.lng !== "function"
      ) {
        throw new Error(
          "Google did not return coordinates for that address. Try another result.",
        );
      }

      selectedPlaceRef.current = {
        address: formattedAddress,

        lat: location.lat(),

        lng: location.lng(),
      };

      setAddress(formattedAddress);

      placesSessionRef.current = null;

      setMessage("Address selected. Confirm the details and add the stop.");
    } catch (error) {
      console.error("Could not select Google address:", error);

      setMessage(
        error instanceof Error
          ? error.message
          : "Could not load the selected address.",
      );
    } finally {
      setBusy(false);
    }
  };

  const stopScanner = useCallback(() => {
    hasScannedRef.current = true;

    controlsRef.current?.stop();

    controlsRef.current = null;

    scannerStartingRef.current = false;

    setScannerOpen(false);
  }, []);

  useEffect(() => {
    return () => {
      hasScannedRef.current = true;

      controlsRef.current?.stop();

      controlsRef.current = null;

      scannerStartingRef.current = false;
    };
  }, []);

  // PDF417 package scanner.

  const scanBarcode = async () => {
    if (scannerStartingRef.current || scannerOpen) return;

    scannerStartingRef.current = true;

    hasScannedRef.current = false;

    setMessage("");

    setScannerOpen(true);

    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");

      const hints = new Map<DecodeHintType, unknown>();

      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]);

      const reader = new BrowserMultiFormatReader(hints, {
        delayBetweenScanAttempts: 100,
      });

      readerRef.current = reader;

      let video = videoRef.current;

      for (let attempt = 0; !video && attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));

        video = videoRef.current;
      }

      if (!video) {
        throw new Error("Camera preview could not be initialized.");
      }

      if (hasScannedRef.current) return;

      const onDecode = (result: any) => {
        if (!result || hasScannedRef.current) return;

        hasScannedRef.current = true;

        const raw = result.getText();

        const format = String(result.getBarcodeFormat());

        const parsed = parseFedExPayload(raw);

        setBarcode(raw);

        if (parsed) {
          if (parsed.address) {
            setAddress(parsed.address);

            selectedPlaceRef.current = null;
          }

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
            `${format} barcode decoded, but the FedEx address format was not recognized. Enter the delivery address manually.`,
          );
        }

        controlsRef.current?.stop();

        controlsRef.current = null;

        scannerStartingRef.current = false;

        setScannerOpen(false);
      };

      try {
        controlsRef.current = await reader.decodeFromConstraints(
          {
            audio: false,

            video: {
              facingMode: { ideal: "environment" },

              width: { ideal: 1280 },

              height: { ideal: 720 },
            },
          },

          video,

          onDecode,
        );
      } catch (primaryError) {
        if (hasScannedRef.current) return;

        const devices = await BrowserMultiFormatReader.listVideoInputDevices();

        if (!devices.length) throw primaryError;

        const preferred = devices.find((device) =>
          /back|rear|environment/i.test(device.label),
        );

        const fallbackDevice = preferred ?? devices[devices.length - 1];

        controlsRef.current = await reader.decodeFromConstraints(
          {
            audio: false,

            video: {
              deviceId: {
                exact: fallbackDevice.deviceId,
              },

              width: { ideal: 1280 },

              height: { ideal: 720 },
            },
          },

          video,

          onDecode,
        );
      }
    } catch (error) {
      controlsRef.current?.stop();

      controlsRef.current = null;

      scannerStartingRef.current = false;

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

    const normalizedBarcode = barcode.trim();

    if (!destination) {
      setMessage("Enter a delivery address before adding the stop.");

      return;
    }

    if (
      normalizedBarcode &&
      stops.some((stop) => stop.barcode.trim() === normalizedBarcode)
    ) {
      setMessage("That barcode is already on your active stop list.");

      return;
    }

    setBusy(true);

    setMessage("Checking address…");

    try {
      let lat: number;

      let lng: number;

      let displayAddress: string;

      const selected = selectedPlaceRef.current;

      if (selected && selected.address === destination) {
        lat = selected.lat;

        lng = selected.lng;

        displayAddress = selected.address;
      } else {
        const response = await fetch(
          `https\://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(destination)}`,

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
            "Address not found. Select a suggestion or check the full address.",
          );
        }

        lat = Number(results[0].lat);

        lng = Number(results[0].lon);

        displayAddress = results[0].display_name || destination;
      }

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error("The address did not return valid map coordinates.");
      }

      const stop: Stop = {
        id: crypto.randomUUID(),

        name: name.trim() || parsed?.name || "",

        address: displayAddress,

        barcode: normalizedBarcode,

        description: description.trim(),

        lat,

        lng,

        createdAt: Date.now(),
      };

      if (
        stop.barcode &&
        stops.some((existing) => existing.barcode === stop.barcode)
      ) {
        setMessage("That barcode is already on your active stop list.");

        return;
      }

      setStops((current) => [...current, stop]);

      setAddress("");

      setBarcode("");

      setName("");

      setDescription("");

      selectedPlaceRef.current = null;

      placesSessionRef.current = null;

      setSuggestions([]);

      setSuggestionsOpen(false);

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
    const stop = stops.find((item) => item.id === id);

    if (!stop) return;

    setStops((current) => current.filter((item) => item.id !== id));

    setCompleted((current) => [stop, ...current]);

    setMessage("Delivery marked complete.");
  };

  const undoStop = (id: string) => {
    const stop = completed.find((item) => item.id === id);

    if (!stop) return;

    setCompleted((current) => current.filter((item) => item.id !== id));

    setStops((current) => [...current, stop]);

    setMessage("Delivery moved back to active stops.");
  };

  const deleteStop = (id: string, isCompleted = false) => {
    const list = isCompleted ? completed : stops;

    const stop = list.find((item) => item.id === id);

    if (!stop) return;

    if (!confirm(`Delete "${stop.name || stop.address}" from your tracker?`)) {
      return;
    }

    if (isCompleted) {
      setCompleted((current) => current.filter((item) => item.id !== id));
    } else {
      setStops((current) => current.filter((item) => item.id !== id));
    }

    setMessage("Stop deleted.");
  };

  const optimizeRoute = async () => {
    if (!stops.length) {
      setMessage("Add at least one stop before optimizing your route.");
      return;
    }

    setOptimizing(true);
    setMessage("Optimizing route from 985 Moodie Drive…");

    try {
      // Fixed station location: 985 Moodie Drive, Nepean, ON.
      const station = { lat: 45.2791694, lng: -75.8085255 };
      // Include the station at both ends to create a round trip.
      const coordinates = [
        `${station.lng},${station.lat}`,
        ...stops.map((stop) => `${stop.lng},${stop.lat}`),
        `${station.lng},${station.lat}`,
      ].join(";");

      const response = await fetch(
        `https://router.project-osrm.org/trip/v1/driving/${coordinates}?source=first&destination=last&roundtrip=false&overview=false`,
      );

      if (!response.ok) {
        throw new Error("The route service is temporarily unavailable.");
      }

      const result = await response.json();

      if (result.code !== "Ok" || !Array.isArray(result.waypoints)) {
        throw new Error(
          "Could not find a drivable round-trip route. Check the map pins and try again.",
        );
      }

      // Input waypoint 0 and the final waypoint are the station;
      // delivery waypoints are input indices 1 through stops.length.
      const optimized = stops
        .map((stop, index) => ({
          stop,
          waypoint: result.waypoints[index + 1],
        }))
        .sort(
          (a, b) =>
            (a.waypoint?.waypoint_index ?? Number.MAX_SAFE_INTEGER) -
            (b.waypoint?.waypoint_index ?? Number.MAX_SAFE_INTEGER),
        )
        .map((entry) => entry.stop);

      if (
        optimized.length !== stops.length ||
        optimized.some((stop) => !stop)
      ) {
        throw new Error(
          "The route service did not return every delivery stop.",
        );
      }

      setStops(optimized);
      setMessage(
        "Route optimized from 985 Moodie Drive and back. Follow the reordered stop list from top to bottom. Live traffic is not included.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not optimize route.",
      );
    } finally {
      setOptimizing(false);
    }
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

  const updateAddress = (value: string) => {
    setAddress(value);

    selectedPlaceRef.current = null;

    setSuggestionsOpen(true);
  };

  return (
    <main className="app-shell">
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

        .address-field {
          position: relative;
        }

        .address-suggestions {
          position: absolute;

          z-index: 1000;

          top: calc(100% - 2px);

          right: 0;

          left: 0;

          overflow: hidden;

          border: 1px solid #dce4eb;

          border-radius: 0 0 12px 12px;

          background: #fff;

          box-shadow: 0 10px 25px rgba(16, 24, 40, 0.12);
        }

        .suggestion-button {
          display: block;

          width: 100%;

          padding: 12px 14px;

          border: 0;

          border-bottom: 1px solid #edf0f3;

          background: #fff;

          color: #202c39;

          font: inherit;

          text-align: left;

          cursor: pointer;
        }

        .suggestion-button:hover,
        .suggestion-button:focus {
          background: #f0f7ff;

          outline: none;
        }

        .suggestion-button:last-child {
          border-bottom: 0;
        }

        .suggestion-main {
          display: block;

          font-size: 13px;

          font-weight: 600;

          line-height: 1.45;
        }

        .suggestion-caption {
          display: block;

          margin-top: 6px;

          padding: 7px 10px;

          background: #f8fafc;

          color: #64748b;

          font-size: 10px;

          text-align: right;
        }

        .optimize-button {
          display: flex;

          width: 100%;

          align-items: center;

          justify-content: center;

          gap: 9px;

          margin: 0 0 14px;

          padding: 12px 14px;

          border: 1px solid #b9d7fa;

          border-radius: 12px;

          background: #eff6ff;

          color: #174b87;

          font: inherit;

          font-size: 13px;

          font-weight: 700;

          cursor: pointer;
        }

        .optimize-button:disabled {
          opacity: 0.55;

          cursor: wait;
        }

        .stop-description {
          display: block;

          margin-top: 7px;

          color: #a65d00;

          font-size: 13px;

          font-weight: 700;

          line-height: 1.45;

          overflow-wrap: anywhere;
        }

        .stop-actions {
          display: flex;

          align-items: center;

          gap: 7px;

          flex-shrink: 0;
        }

        .delete-button {
          display: inline-flex;

          width: 34px;

          height: 34px;

          align-items: center;

          justify-content: center;

          border: 1px solid #f1c9c9;

          border-radius: 9px;

          background: #fff;

          color: #b42318;

          font-size: 18px;

          cursor: pointer;
        }

        .delete-button:hover {
          background: #fff1f0;
        }

        .completed-item .stop-actions {
          margin-left: auto;
        }

        @media (max-width: 600px) {
          .stop-item {
            flex-wrap: wrap;
          }

          .stop-details {
            min-width: 0;

            flex: 1;
          }

          .stop-actions {
            width: 100%;

            justify-content: flex-end;
          }

          .scan-frame {
            width: 92%;

            height: 40%;
          }

          .corner {
            width: 20px;

            height: 20px;
          }
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
                    if (parsed.address) {
                      setAddress(parsed.address);

                      selectedPlaceRef.current = null;
                    }

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
              PACKAGE DESCRIPTION <span>OPTIONAL</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Large box — behind passenger seat"
              />
            </label>

            <label className="address-field">
              DELIVERY ADDRESS <b>*</b>
              <textarea
                required
                value={address}
                onChange={(e) => updateAddress(e.target.value)}
                onFocus={() => setSuggestionsOpen(true)}
                onBlur={() => {
                  window.setTimeout(() => setSuggestionsOpen(false), 180);
                }}
                placeholder="Start typing a street address…"
                rows={3}
                autoComplete="off"
              />
              {suggestionsOpen && suggestions.length > 0 && (
                <div
                  className="address-suggestions"
                  role="listbox"
                  aria-label="Address suggestions"
                >
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion.id}
                      type="button"
                      className="suggestion-button"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void selectSuggestion(suggestion)}
                    >
                      <span className="suggestion-main">
                        {suggestion.label}
                      </span>
                    </button>
                  ))}

                  <div className="suggestion-caption">
                    Google Maps address suggestions
                  </div>
                </div>
              )}
            </label>

            <button className="add-button" disabled={busy}>
              {busy ? (
                <>
                  <span className="spinner" /> Working…
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
                /failed|could not|not found|already|no camera|camera error|denied|error/i.test(
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
              PDF417 barcodes are decoded in your browser. Confirm the address
              and package description before adding a stop.
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

        <button
          type="button"
          className="optimize-button"
          disabled={optimizing || stops.length === 0}
          onClick={() => void optimizeRoute()}
        >
          <span>{optimizing ? "◌" : "⌖"}</span>

          {optimizing
            ? "Optimizing route…"
            : `Optimize round trip from 985 Moodie Drive (${stops.length} stops)`}
        </button>

        {stops.length ? (
          <div className="stop-list">
            {stops.map((stop, index) => (
              <article className="stop-item" key={stop.id}>
                <div className="stop-index">
                  {String(index + 1).padStart(2, "0")}
                </div>

                <div className="stop-details">
                  <strong>{stop.name || `Delivery stop ${index + 1}`}</strong>

                  <span>{stop.address}</span>

                  {stop.description && (
                    <span className="stop-description">
                      Package: {stop.description}
                    </span>
                  )}
                </div>

                <div className="stop-actions">
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
                    aria-label={`Complete ${stop.name || stop.address}`}
                  >
                    ✓
                  </button>

                  <button
                    className="delete-button"
                    onClick={() => deleteStop(stop.id)}
                    title="Delete this stop"
                    aria-label={`Delete ${stop.name || stop.address}`}
                  >
                    ×
                  </button>
                </div>
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

                    {stop.description && (
                      <span className="stop-description">
                        Package: {stop.description}
                      </span>
                    )}
                  </div>

                  <div className="stop-actions">
                    <button
                      className="undo-button"
                      onClick={() => undoStop(stop.id)}
                    >
                      Undo
                    </button>

                    <button
                      className="delete-button"
                      onClick={() => deleteStop(stop.id, true)}
                      title="Delete completed stop"
                      aria-label={`Delete ${stop.name || stop.address}`}
                    >
                      ×
                    </button>
                  </div>
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
