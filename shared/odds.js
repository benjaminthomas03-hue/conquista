// Battle maths shared by the server (bots, luck stats) and the browser (odds preview).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CONQUISTA_ODDS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Exact outcome distributions for one roll: [attackerDice][defenderDice] -> list of
  // { p, att: attacker losses, def: defender losses }.
  const ROLL = {
    3: { 2: [{ p: 2890 / 7776, att: 0, def: 2 }, { p: 2611 / 7776, att: 1, def: 1 }, { p: 2275 / 7776, att: 2, def: 0 }],
         1: [{ p: 855 / 1296, att: 0, def: 1 }, { p: 441 / 1296, att: 1, def: 0 }] },
    2: { 2: [{ p: 295 / 1296, att: 0, def: 2 }, { p: 420 / 1296, att: 1, def: 1 }, { p: 581 / 1296, att: 2, def: 0 }],
         1: [{ p: 125 / 216, att: 0, def: 1 }, { p: 91 / 216, att: 1, def: 0 }] },
    1: { 2: [{ p: 55 / 216, att: 0, def: 1 }, { p: 161 / 216, att: 1, def: 0 }],
         1: [{ p: 15 / 36, att: 0, def: 1 }, { p: 21 / 36, att: 1, def: 0 }] },
  };

  // Expected losses for a single roll (used for "luck" stats).
  function expectedLosses(attDice, defDice) {
    let att = 0, def = 0;
    for (const o of ROLL[attDice][defDice]) { att += o.p * o.att; def += o.p * o.def; }
    return { att, def };
  }

  // Probability the attacker conquers when attacking with `attackers` armies on the source
  // territory (one must stay behind) against `defenders`, rolling max dice until win or
  // down to 1 army (i.e. a blitz). Also returns expected armies left on each side.
  const memo = new Map();
  function blitz(attackers, defenders) {
    attackers = Math.min(attackers, 200); defenders = Math.min(defenders, 200);
    const key = attackers * 1000 + defenders;
    if (memo.has(key)) return memo.get(key);
    let res;
    if (defenders <= 0) res = { win: 1, attLeft: attackers, defLeft: 0 };
    else if (attackers <= 1) res = { win: 0, attLeft: attackers, defLeft: defenders };
    else {
      const a = Math.min(3, attackers - 1), d = Math.min(2, defenders);
      res = { win: 0, attLeft: 0, defLeft: 0 };
      for (const o of ROLL[a][d]) {
        const r = blitz(attackers - o.att, defenders - o.def);
        res.win += o.p * r.win; res.attLeft += o.p * r.attLeft; res.defLeft += o.p * r.defLeft;
      }
    }
    memo.set(key, res);
    return res;
  }

  return { ROLL, expectedLosses, blitz };
});
