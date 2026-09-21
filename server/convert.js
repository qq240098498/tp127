const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;

const pad = (num) => String(num).padStart(2, '0');

// 日期要真存在，例如 2026-02-30 这种不能算数
function validateDate(value) {
  const date = pickText(value);
  if (!date) throw new ApiError(400, 'DATE_REQUIRED', '请填写日期', 'date');
  if (!DATE_PATTERN.test(date)) {
    throw new ApiError(400, 'DATE_INVALID', '日期要写成四位年加短横线加两位月日，例如 2026-09-20', 'date');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，请检查月份与日', 'date');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，例如二月没有三十号', 'date');
  }
  return { text: date, year, month, day };
}

function validateTime(value) {
  const time = pickText(value);
  if (!time) throw new ApiError(400, 'TIME_REQUIRED', '请填写时刻', 'time');
  if (!TIME_PATTERN.test(time)) {
    throw new ApiError(400, 'TIME_INVALID', '时刻要写成两位小时加冒号加两位分钟，例如 09:30', 'time');
  }
  const [hour, minute] = time.split(':').map(Number);
  return { text: time, hour, minute };
}

// 时差写法：整小时只写小时，带分钟的把分钟也写出来
function diffText(minutes) {
  if (minutes === 0) return '与源时区相同';
  const sign = minutes > 0 ? '早' : '晚';
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return `比源时区${sign} ${parts.join(' ')}`;
}

function dayOffsetText(dayOffset) {
  if (dayOffset === 0) return '同日';
  if (dayOffset > 0) return `后 ${dayOffset} 天`;
  return `前 ${Math.abs(dayOffset)} 天`;
}

// 分组标题里的侧别：落在来源日期之前的叫前一天侧，之后的叫后一天侧，当天的标来源当天
function sideText(dayOffset) {
  if (dayOffset < 0) return '前一天侧';
  if (dayOffset > 0) return '后一天侧';
  return '来源当天';
}

// 组标题里写清这一天是本地哪一天、星期几、当天有几个地区
function groupTitleText(group) {
  return `${group.localDate} ${group.weekday} · ${group.count} 个地区`;
}

// 按当地日期把换算结果分组：同一天归一组，键里带年份，同月日但跨年的自然分成两组。
// 组的排列顺序为前一天侧、来源当天、后一天侧；同一侧内按日期先后。组内按时刻从早到晚。
// 分组直接由每条结果的 localDate 建键，因此每条结果恰好落进唯一一组：
// 不会同时出现在两组，也不会哪一组都没落进去。
function groupResults(results) {
  const groups = new Map();
  results.forEach((item) => {
    const group = groups.get(item.localDate);
    if (group) {
      group.items.push(item);
      group.count += 1;
      // 同一 localDate 算出的 dayOffset、星期必然一致，取第一条即可
      return;
    }
    groups.set(item.localDate, {
      key: item.localDate,
      localDate: item.localDate,
      year: Number(item.localDate.slice(0, 4)),
      month: Number(item.localDate.slice(5, 7)),
      day: Number(item.localDate.slice(8, 10)),
      weekday: item.weekday,
      dayOffset: item.dayOffset,
      dayOffsetText: dayOffsetText(item.dayOffset),
      side: item.dayOffset < 0 ? 'before' : item.dayOffset > 0 ? 'after' : 'same',
      sideText: sideText(item.dayOffset),
      count: 1,
      items: [item],
    });
  });

  const list = Array.from(groups.values());
  list.sort((a, b) => {
    // 先按侧别分开：前一天侧在最前、来源当天居中、后一天侧在最后
    const sideRank = { before: 0, same: 1, after: 2 };
    if (sideRank[a.side] !== sideRank[b.side]) return sideRank[a.side] - sideRank[b.side];
    // 跨到前一天的组理论上可差出两天以上，同一侧内再按日期先后兜底
    if (a.localDate !== b.localDate) return a.localDate < b.localDate ? -1 : 1;
    return 0;
  });
  list.forEach((group) => {
    // 组内按当地时刻从早到晚，同一时刻再按时区名兜底，保证顺序确定
    group.items.sort((a, b) => {
      if (a.localTime !== b.localTime) return a.localTime < b.localTime ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    group.titleText = groupTitleText(group);
  });

  return list;
}

// 换算：先把输入时刻按来源时区的偏移折算成基准时刻，再逐个时区加上各自的偏移
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const baseMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const utcMs = baseMs - source.offsetMinutes * 60000;
  const baseDay = Math.floor(baseMs / DAY_MS);
  const utcDate = new Date(utcMs);

  const results = data.zones.map((zone) => {
    const localMs = utcMs + zone.offsetMinutes * 60000;
    const local = new Date(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = zone.offsetMinutes - source.offsetMinutes;
    return {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: zone.offsetMinutes,
      offsetText: offsetText(zone.offsetMinutes),
      localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
      localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      weekday: WEEKDAY_NAMES[local.getUTCDay()],
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
      usesDst: zone.usesDst,
      isSource: zone.id === source.id,
    };
  });

  results.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes;
    return a.name < b.name ? -1 : 1;
  });

  const groups = groupResults(results);

  return {
    input: {
      date: date.text,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(source.offsetMinutes),
      usesDst: source.usesDst,
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    zonesInScope: data.zones.length,
    crossDayCount: results.filter((item) => item.dayOffset !== 0).length,
    maxDiffMinutes: results.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
    groups,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = { convert, validateDate, validateTime, diffText, dayOffsetText, groupResults };
