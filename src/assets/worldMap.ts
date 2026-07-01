// A simplified low-resolution world map path outline to fit within the SVG.
// Coordinates map from -180..180 (longitude) to -90..90 (latitude).
// Let's create an exportable SVG path/component for rendering a simple world map.
export const WORLD_MAP_PATHS = [
  // North America
  "M -168 65 L -155 60 L -120 70 L -100 75 L -80 75 L -60 60 L -50 60 L -60 45 L -80 50 L -90 40 L -95 15 L -105 20 L -115 15 L -100 30 L -120 35 L -125 48 L -165 54 Z",
  // South America
  "M -80 12 L -70 8 L -45 -5 L -35 -5 L -40 -20 L -60 -40 L -70 -50 L -75 -55 L -73 -40 L -80 -20 L -80 -5 Z",
  // Greenland
  "M -60 75 L -40 75 L -30 70 L -40 60 L -55 60 Z",
  // Africa
  "M -15 35 L 0 36 L 15 30 L 30 31 L 32 30 L 50 12 L 40 -15 L 20 -33 L 18 -34 L 10 -15 L -10 5 L -17 15 Z",
  // Eurasia
  "M -10 65 L 10 70 L 30 75 L 60 78 L 90 75 L 120 75 L 140 75 L 170 70 L 180 60 L 160 50 L 140 30 L 120 30 L 105 20 L 80 10 L 75 35 L 45 40 L 35 25 L 30 40 L 10 40 L -5 50 Z",
  // Australia
  "M 115 -20 L 140 -15 L 150 -25 L 145 -35 L 115 -32 Z"
];
