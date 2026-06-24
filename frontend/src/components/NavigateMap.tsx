import React, { useEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, View, Text } from "react-native";
import { WebView } from "react-native-webview";

import { Stop } from "@/src/api";
import { colors } from "@/src/theme";

type Props = {
  user?: { lat: number; lng: number } | null;
  target: Stop;
  next: Stop[];
  polyline?: [number, number][];
  heading?: number | null;
  follow?: boolean;
};

function buildHtml(target: Stop, next: Stop[]): string {
  const data = JSON.stringify({
    target: {
      lat: target.lat,
      lng: target.lng,
      order: target.order,
      address: target.address,
      recipient: target.recipient_name,
      cod: !!target.is_cod || (target.cod_amount || 0) > 0,
    },
    next: next
      .filter((s) => typeof s.lat === "number" && typeof s.lng === "number")
      .slice(0, 5)
      .map((s) => ({
        lat: s.lat,
        lng: s.lng,
        order: s.order,
        address: s.address,
        recipient: s.recipient_name,
      })),
  });

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  html,body,#map{height:100%;margin:0;padding:0;background:#F3F4F6;}
  .pin-wrap{display:flex;align-items:center;justify-content:center;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);color:#fff;font-weight:900;font-family:-apple-system,Roboto,sans-serif;}
  .pin-target{width:44px;height:44px;background:#E63329;font-size:16px;}
  .pin-next{width:30px;height:30px;background:#0A0A0A;font-size:12px;opacity:.85;}
  .pin-user{width:0;height:0;border-left:12px solid transparent;border-right:12px solid transparent;border-bottom:24px solid #1E88E5;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));border-radius:0;border-top:0;background:transparent;box-shadow:none;}
  .leaflet-control-attribution{display:none;}
</style>
</head><body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate.js"></script>
<script>
(function(){
  var d = ${data};
  var map = L.map('map', { zoomControl: true, rotate: true, touchRotate: false, bearing: 0 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  var bounds = [];
  if (typeof d.target.lat === 'number' && typeof d.target.lng === 'number') {
    var tIcon = L.divIcon({ className:'', html:'<div class="pin-wrap pin-target">' + d.target.order + '</div>', iconSize:[44,44], iconAnchor:[22,22] });
    L.marker([d.target.lat, d.target.lng], { icon: tIcon, zIndexOffset: 1000 }).addTo(map)
      .bindPopup('<b>' + d.target.order + '. ' + (d.target.recipient || '').replace(/</g,'&lt;') + '</b><br/>' + (d.target.address || '').replace(/</g,'&lt;'));
    bounds.push([d.target.lat, d.target.lng]);
  }
  d.next.forEach(function(s){
    var ni = L.divIcon({ className:'', html:'<div class="pin-wrap pin-next">' + s.order + '</div>', iconSize:[30,30], iconAnchor:[15,15] });
    L.marker([s.lat, s.lng], { icon: ni }).addTo(map)
      .bindPopup('<b>' + s.order + '. ' + (s.recipient || '').replace(/</g,'&lt;') + '</b><br/>' + (s.address || '').replace(/</g,'&lt;'));
    bounds.push([s.lat, s.lng]);
  });
  if (bounds.length === 1) map.setView(bounds[0], 15);
  else if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds).pad(0.2));
  else map.setView([52.1, 19.4], 6);

  var userMarker = null;
  var polylineLayer = null;

  function makeUserIcon(headingDeg) {
    return L.divIcon({
      className: '',
      html: '<div style="transform: rotate(' + (headingDeg || 0) + 'deg);transform-origin:center 75%"><div class="pin-wrap pin-user"></div></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 18]
    });
  }

  window.__updateNav = function(payload) {
    if (payload.user) {
      var ll = [payload.user.lat, payload.user.lng];
      if (!userMarker) {
        userMarker = L.marker(ll, { icon: makeUserIcon(payload.heading), zIndexOffset: 2000 }).addTo(map);
      } else {
        userMarker.setLatLng(ll);
        userMarker.setIcon(makeUserIcon(payload.heading));
      }
      if (payload.follow) {
        // Chase-camera: zoom in close, center on user, rotate by heading.
        var z = map.getZoom() < 17 ? 17 : map.getZoom();
        map.setView(ll, z, { animate: true, duration: 0.5 });
        if (typeof payload.heading === 'number' && typeof map.setBearing === 'function') {
          try { map.setBearing(-payload.heading); } catch(e){}
        }
      }
    }
    if (payload.polyline && payload.polyline.length > 1) {
      if (polylineLayer) { map.removeLayer(polylineLayer); polylineLayer = null; }
      polylineLayer = L.polyline(payload.polyline, { color: '#E63329', weight: 5, opacity: 0.85, lineCap: 'round' }).addTo(map);
    }
  };

  window.addEventListener('message', function(e){
    try {
      var data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (data && data.type === 'navUpdate' && window.__updateNav) window.__updateNav(data.payload);
    } catch(err){}
  });
})();
</script>
</body></html>`;
}

export function NavigateMap(props: Props) {
  const { user, polyline, heading, follow, target, next } = props;

  // Static HTML keyed on the target stop id — keeps map alive while user position
  // and polyline stream in via postMessage / injectJavaScript.
  const html = useMemo(() => buildHtml(target, next), [target.id, target.lat, target.lng, next.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const webViewRef = useRef<WebView | null>(null);

  // Push live updates to the map without rebuilding it.
  useEffect(() => {
    if (!user && !polyline) return;
    const payload = {
      user: user || null,
      heading: typeof heading === "number" ? heading : null,
      follow: !!follow,
      polyline: polyline || null,
    };
    const message = JSON.stringify({ type: "navUpdate", payload });

    if (Platform.OS === "web") {
      try {
        iframeRef.current?.contentWindow?.postMessage(message, "*");
      } catch {
        /* noop */
      }
    } else if (webViewRef.current) {
      const escaped = message.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const script = `try { window.postMessage('${escaped}', '*'); } catch(e){}; true;`;
      webViewRef.current.injectJavaScript(script);
    }
  }, [user?.lat, user?.lng, heading, follow, polyline]); // eslint-disable-line react-hooks/exhaustive-deps

  if (Platform.OS === "web") {
    const dataUri = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Iframe = "iframe" as any;
    return (
      <View style={styles.wrap} testID="navigate-map">
        <Iframe
          ref={iframeRef}
          src={dataUri}
          style={{ width: "100%", height: "100%", border: 0 }}
          title="Nawigacja"
        />
      </View>
    );
  }

  return (
    <View style={styles.wrap} testID="navigate-map">
      <WebView
        ref={webViewRef}
        originWhitelist={["*"]}
        source={{ html }}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
        scalesPageToFit
      />
    </View>
  );
}

export function PlaceholderMap({ message }: { message: string }) {
  return (
    <View style={[styles.wrap, styles.placeholder]} testID="navigate-map-placeholder">
      <Text style={styles.placeholderText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  web: { flex: 1, backgroundColor: colors.bg },
  placeholder: { alignItems: "center", justifyContent: "center", padding: 24 },
  placeholderText: { color: colors.textSecondary, textAlign: "center" },
});
