import { checkForMissingUnits } from "./missingUnitChecker";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getGenerators } from "./generators";

vi.mock('./generators');

const mockedGetGenerators = vi.mocked(getGenerators);

describe('checkForMissingUnits', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('should return an empty array if there are no generators', async () => {
		mockedGetGenerators.mockResolvedValue([]);

		const result = await checkForMissingUnits([]);
		expect(result).toEqual({
			generationUnitsNotInDispatchList: [],
			generationUnitsNotInGeneratorList: []
		});
	});

	it('should return an empty array if there are no missing units', async () => {
		mockedGetGenerators.mockResolvedValue([{
			units: [
				{
					node: '1234567890 ABCD'
				}
			]
		}]);

		const result = await checkForMissingUnits(['1234567890 ABCD']);
		expect(result).toEqual({
			generationUnitsNotInDispatchList: [],
			generationUnitsNotInGeneratorList: []
		});
	});

	it('should return an array of missing units if there are missing units in the dispatch list', async () => {
		mockedGetGenerators.mockResolvedValue([{
			units: [
				{
					node: '1234567890 ABCD'
				}
			]
		}]);

		const result = await checkForMissingUnits([]);
		expect(result).toEqual({
			generationUnitsNotInDispatchList: ['1234567890 ABCD'],
			generationUnitsNotInGeneratorList: []
		});
	});

	it('should return an empty array of missing units if there are missing units in the dispatch list but the unit is listed as inactive in the generator list', async () => {
		mockedGetGenerators.mockResolvedValue([{
			units: [
				{
					node: '1234567890 ABCD',
					active: false
				}
			]
		}]);

		const result = await checkForMissingUnits([]);
		expect(result).toEqual({
			generationUnitsNotInDispatchList: [],
			generationUnitsNotInGeneratorList: []
		});
	});

	it('should return an array of units not in the generator list if there are units not in the generator list', async () => {
		mockedGetGenerators.mockResolvedValue([]);

		const result = await checkForMissingUnits(['1234567890 ABCD']);
		expect(result).toEqual({
			generationUnitsNotInDispatchList: [],
			generationUnitsNotInGeneratorList: ['1234567890 ABCD']
		});
	});

	it('should satisfy both conditions if there are missing units and units not in the generator list', async () => {
		mockedGetGenerators.mockResolvedValue([{
			units: [
				{
					node: '1234567890 ABCD'
				}
			]
		}]);

		const result = await checkForMissingUnits(['9876543210 ABCD']);
		expect(result).toEqual({
			generationUnitsNotInDispatchList: ['1234567890 ABCD'],
			generationUnitsNotInGeneratorList: ['9876543210 ABCD']
		});
	});
});