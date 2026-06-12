export function formatRuPlural(
  count: number,
  forms: readonly [string, string, string],
) {
  const absolute = Math.abs(count);
  const lastTwo = absolute % 100;
  const last = absolute % 10;
  const form =
    lastTwo >= 11 && lastTwo <= 14
      ? forms[2]
      : last === 1
        ? forms[0]
        : last >= 2 && last <= 4
          ? forms[1]
          : forms[2];
  return `${count} ${form}`;
}

export function formatRuItemsRequireDecision(count: number) {
  const subject = formatRuPlural(count, ["пункт", "пункта", "пунктов"]);
  const verb = Math.abs(count) % 10 === 1 && Math.abs(count) % 100 !== 11 ? "требует" : "требуют";
  return `${subject} ${verb} решения`;
}
