import { tempCodeToCelsius, celciusToTempCode, parseDate, addMinutes } from '../src/util';
import { REGIONS } from '../src/constants';

describe('Utility', () => {
  it('converts temp code to celsius in EU', () => {
    expect(tempCodeToCelsius(REGIONS.EU, '06H')).toEqual(17);
    expect(tempCodeToCelsius(REGIONS.EU, '0CH')).toEqual(20);
    expect(tempCodeToCelsius(REGIONS.EU, '1AH')).toEqual(27);
  });

  it('converts celcius to temp code in EU', () => {
    expect(celciusToTempCode(REGIONS.EU, 17)).toEqual('06H');
    expect(celciusToTempCode(REGIONS.EU, 20)).toEqual('0CH');
    expect(celciusToTempCode(REGIONS.EU, 27)).toEqual('1AH');
  });

  it('parseDate converts string to date', () => {
    expect(parseDate('20210118153031')).toEqual(new Date('2021-01-18:15:30:31'));
  });

  it('parseDate converts shortdate to date', () => {
    expect(parseDate('20210117')).toEqual(new Date('2021-01-17:00:00:00'));
  });

  it('parseDate converts very shortdate to date', () => {
    expect(parseDate('202101')).toEqual(new Date('2021-01-01:00:00:00'));
  });

  it('addTime can add minutes to a date', () => {
    const start = new Date('2021-01-18:12:00:00');
    expect(addMinutes(start, 30)).toEqual(new Date('2021-01-18:12:30:00'));
  });
});
