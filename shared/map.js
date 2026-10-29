// Conquista world map: 42 territories, 6 continents, adjacency graph.
// Shared by the server (rules) and the browser (rendering). Works as CommonJS or a browser global.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CONQUISTA_MAP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CONTINENTS = {
    NA: { name: 'North America', bonus: 5, color: '#dcc77e' },
    SA: { name: 'South America', bonus: 2, color: '#c08a6c' },
    EU: { name: 'Europe',        bonus: 5, color: '#98a9b5' },
    AF: { name: 'Africa',        bonus: 3, color: '#c98a55' },
    AS: { name: 'Asia',          bonus: 7, color: '#a5ad79' },
    AU: { name: 'Australia',     bonus: 2, color: '#b39aa6' },
  };

  // id: [name, continent, x, y]  (board is 1000 x 560)
  const T = {
    alaska:        ['Alaska', 'NA', 70, 95],
    nwt:           ['Northwest Territory', 'NA', 160, 82],
    greenland:     ['Greenland', 'NA', 335, 52],
    alberta:       ['Alberta', 'NA', 150, 145],
    ontario:       ['Ontario', 'NA', 225, 148],
    quebec:        ['Quebec', 'NA', 298, 140],
    westernUS:     ['Western US', 'NA', 160, 210],
    easternUS:     ['Eastern US', 'NA', 245, 220],
    centralAm:     ['Central America', 'NA', 190, 285],

    venezuela:     ['Venezuela', 'SA', 262, 330],
    peru:          ['Peru', 'SA', 262, 408],
    brazil:        ['Brazil', 'SA', 335, 385],
    argentina:     ['Argentina', 'SA', 290, 485],

    iceland:       ['Iceland', 'EU', 425, 92],
    scandinavia:   ['Scandinavia', 'EU', 515, 78],
    greatBritain:  ['Great Britain', 'EU', 440, 160],
    northEurope:   ['Northern Europe', 'EU', 515, 155],
    westEurope:    ['Western Europe', 'EU', 450, 235],
    southEurope:   ['Southern Europe', 'EU', 530, 222],
    ukraine:       ['Ukraine', 'EU', 600, 125],

    northAfrica:   ['North Africa', 'AF', 470, 325],
    egypt:         ['Egypt', 'AF', 560, 298],
    eastAfrica:    ['East Africa', 'AF', 615, 375],
    congo:         ['Congo', 'AF', 535, 400],
    southAfrica:   ['South Africa', 'AF', 565, 488],
    madagascar:    ['Madagascar', 'AF', 660, 472],

    ural:          ['Ural', 'AS', 690, 105],
    siberia:       ['Siberia', 'AS', 765, 65],
    yakutsk:       ['Yakutsk', 'AS', 855, 52],
    kamchatka:     ['Kamchatka', 'AS', 940, 72],
    irkutsk:       ['Irkutsk', 'AS', 835, 122],
    mongolia:      ['Mongolia', 'AS', 860, 185],
    japan:         ['Japan', 'AS', 952, 195],
    afghanistan:   ['Afghanistan', 'AS', 682, 192],
    china:         ['China', 'AS', 790, 238],
    middleEast:    ['Middle East', 'AS', 630, 268],
    india:         ['India', 'AS', 725, 300],
    siam:          ['Siam', 'AS', 815, 318],

    indonesia:     ['Indonesia', 'AU', 820, 405],
    newGuinea:     ['New Guinea', 'AU', 915, 385],
    westAustralia: ['Western Australia', 'AU', 850, 490],
    eastAustralia: ['Eastern Australia', 'AU', 940, 478],
  };

  const EDGES = [
    ['alaska','nwt'],['alaska','alberta'],['alaska','kamchatka'],
    ['nwt','alberta'],['nwt','ontario'],['nwt','greenland'],
    ['greenland','ontario'],['greenland','quebec'],['greenland','iceland'],
    ['alberta','ontario'],['alberta','westernUS'],
    ['ontario','westernUS'],['ontario','easternUS'],['ontario','quebec'],
    ['quebec','easternUS'],
    ['westernUS','easternUS'],['westernUS','centralAm'],
    ['easternUS','centralAm'],
    ['centralAm','venezuela'],
    ['venezuela','peru'],['venezuela','brazil'],
    ['peru','brazil'],['peru','argentina'],
    ['brazil','argentina'],['brazil','northAfrica'],
    ['iceland','greatBritain'],['iceland','scandinavia'],
    ['scandinavia','greatBritain'],['scandinavia','northEurope'],['scandinavia','ukraine'],
    ['greatBritain','northEurope'],['greatBritain','westEurope'],
    ['northEurope','ukraine'],['northEurope','southEurope'],['northEurope','westEurope'],
    ['westEurope','southEurope'],['westEurope','northAfrica'],
    ['southEurope','ukraine'],['southEurope','middleEast'],['southEurope','egypt'],['southEurope','northAfrica'],
    ['ukraine','middleEast'],['ukraine','afghanistan'],['ukraine','ural'],
    ['northAfrica','egypt'],['northAfrica','eastAfrica'],['northAfrica','congo'],
    ['egypt','middleEast'],['egypt','eastAfrica'],
    ['eastAfrica','congo'],['eastAfrica','southAfrica'],['eastAfrica','madagascar'],['eastAfrica','middleEast'],
    ['congo','southAfrica'],
    ['southAfrica','madagascar'],
    ['ural','siberia'],['ural','china'],['ural','afghanistan'],
    ['siberia','yakutsk'],['siberia','irkutsk'],['siberia','mongolia'],['siberia','china'],
    ['yakutsk','kamchatka'],['yakutsk','irkutsk'],
    ['kamchatka','irkutsk'],['kamchatka','mongolia'],['kamchatka','japan'],
    ['irkutsk','mongolia'],
    ['mongolia','japan'],['mongolia','china'],
    ['afghanistan','china'],['afghanistan','india'],['afghanistan','middleEast'],
    ['china','siam'],['china','india'],
    ['middleEast','india'],
    ['india','siam'],
    ['siam','indonesia'],
    ['indonesia','newGuinea'],['indonesia','westAustralia'],
    ['newGuinea','westAustralia'],['newGuinea','eastAustralia'],
    ['westAustralia','eastAustralia'],
  ];

  const territories = {};
  for (const [id, [name, continent, x, y]] of Object.entries(T)) {
    territories[id] = { id, name, continent, x, y, neighbors: [] };
  }
  for (const [a, b] of EDGES) {
    if (!territories[a] || !territories[b]) throw new Error('Bad edge ' + a + '-' + b);
    territories[a].neighbors.push(b);
    territories[b].neighbors.push(a);
  }
  const continentTerritories = {};
  for (const c of Object.keys(CONTINENTS)) continentTerritories[c] = [];
  for (const t of Object.values(territories)) continentTerritories[t.continent].push(t.id);

  return { CONTINENTS, territories, edges: EDGES, continentTerritories, width: 1000, height: 560 };
});
