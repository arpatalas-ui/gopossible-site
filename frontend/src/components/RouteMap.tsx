import React, { useMemo } from "react";
import { Platform, StyleSheet, View, Text } from "react-native";
import { WebView } from "react-native-webview";

import { Stop } from "@/src/api";
import { colors } from "@/src/theme";

type Props = {
  stops: Stop[];
  onStopPress?: (stopId: string) => void;
  height?: number;
  /** Stop IDs flagged as outliers (geocoded far from the cluster). Will be drawn yellow with a ring. */
  outlierIds?: string[];
};

function buildHtml(stops: Stop[], outlierIds: string[] = []): string {
  const outlierSet = new Set(outlierIds);
  const pts = stops
    .filter((s) => typeof s.lat === "number" && typeof s.lng === "number")
    .map((s) => ({
      id: s.id,
      order: s.order,
      lat: s.lat,
      lng: s.lng,
      status: s.status,
      address: s.address,
      recipient: s.recipient_name,
      cod: !!s.is_cod || (s.cod_amount || 0) > 0,
      outlier: outlierSet.has(s.id),
    }));

  const data = JSON.stringify(pts);

  // NOTE: Use ASCII-only inside the HTML script to avoid any encoding issues on Android WebView.
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  html,body,#map{height:100%;margin:0;padding:0;background:#F3F4F6;}
  .pin-wrap{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);color:#fff;font-weight:900;font-size:13px;font-family:-apple-system,Roboto,sans-serif;}
  .leaflet-popup-content{font-family:-apple-system,Roboto,sans-serif;font-size:13px;}
</style>
</head><body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function(){
  var stops = ${data};
  var map = L.map('map', { zoomControl: true, attributionControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
  }).addTo(map);

  var markers = [];
  stops.forEach(function(s){
    var color = s.outlier ? '#FFB300'
              : s.status === 'delivered' ? '#00B14F'
              : s.status === 'absent' ? '#1F1F1F'
              : s.cod ? '#FFB300' : '#E63329';
    var ring = s.outlier ? '4px solid #B00020' : '2px solid #fff';
    var icon = L.divIcon({
      className: '',
      html: '<div class="pin-wrap" style="background:' + color + ';border:' + ring + '">' + s.order + '</div>',
      iconSize: [34,34],
      iconAnchor: [17,17]
    });
    var m = L.marker([s.lat, s.lng], { icon: icon }).addTo(map);
    var safeAddr = (s.address || '').replace(/</g,'&lt;');
    var safeRec = (s.recipient || '').replace(/</g,'&lt;');
    m.bindPopup('<b>' + s.order + '. ' + safeRec + '</b><br/>' + safeAddr);
    m.on('click', function(){
      try {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(s.id);
        } else if (window.parent) {
          window.parent.postMessage(s.id, '*');
        }
      } catch(e){}
    });
    markers.push(m);
  });

  if (markers.length) {
    var group = L.featureGroup(markers);
    map.fitBounds(group.getBounds().pad(0.15));
  } else {
    map.setView([52.1, 19.4], 6);
  }
})();
</script>
</body></html>`;
}

export function RouteMap({ stops, onStopPress, height = 260, outlierIds }: Props) {
  const hasCoords = stops.some((s) => typeof s.lat === "number" && typeof s.lng === "number");
  const html = useMemo(() => buildHtml(stops, outlierIds), [stops, outlierIds]);

  if (!hasCoords) {
    return (
      <View style={[styles.placeholder, { height }]} testID="route-map-placeholder">
        <Text style={styles.placeholderText}>
          Mapa będzie dostępna gdy AI rozpozna współrzędne adresów. Wgraj manifest ponownie aby uzupełnić dane.
        </Text>
      </View>
    );
  }

  if (Platform.OS === "web") {
    // react-native-webview on web doesn't reliably render srcDoc; use a native iframe instead.
    const dataUri = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Iframe = "iframe" as any;
    return (
      <View style={[styles.wrap, { height }]} testID="route-map">
        <Iframe
          src={dataUri}
          style={{ width: "100%", height: "100%", border: 0, borderRadius: 12 }}
          title="Mapa trasy"
        />
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { height }]} testID="route-map">
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
        scalesPageToFit
        onMessage={(e) => {
          const id = e.nativeEvent.data;
          if (id && onStopPress) onStopPress(id);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  web: { flex: 1, backgroundColor: colors.bg },
  placeholder: {
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  placeholderText: {
    color: colors.textSecondary,
    textAlign: "center",
    fontSize: 13,
  },
});
