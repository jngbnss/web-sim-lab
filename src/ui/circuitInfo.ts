/**
 * Country (three-letter code, as on the F1 timing screens: flag emoji do not render on
 * Windows) and the official number of corners (FIA / F1 circuit guides), for the menu cards.
 */
export const CIRCUIT_INFO: Record<string, { code: string; corners: number }> = {
  melbourne: { code: 'AUS', corners: 14 },
  shanghai: { code: 'CHN', corners: 16 },
  suzuka: { code: 'JPN', corners: 18 },
  sakhir: { code: 'BHR', corners: 15 },
  jeddah: { code: 'KSA', corners: 27 },
  miami: { code: 'USA', corners: 19 },
  montreal: { code: 'CAN', corners: 14 },
  monaco: { code: 'MON', corners: 19 },
  catalunya: { code: 'ESP', corners: 14 },
  spielberg: { code: 'AUT', corners: 10 },
  silverstone: { code: 'GBR', corners: 18 },
  spa: { code: 'BEL', corners: 19 },
  budapest: { code: 'HUN', corners: 14 },
  zandvoort: { code: 'NED', corners: 14 },
  monza: { code: 'ITA', corners: 11 },
  madrid: { code: 'ESP', corners: 22 },
  baku: { code: 'AZE', corners: 20 },
  singapore: { code: 'SGP', corners: 19 },
  austin: { code: 'USA', corners: 20 },
  mexicocity: { code: 'MEX', corners: 17 },
  saopaulo: { code: 'BRA', corners: 15 },
  lasvegas: { code: 'USA', corners: 17 },
  lusail: { code: 'QAT', corners: 16 },
  yasmarina: { code: 'UAE', corners: 16 },
};
