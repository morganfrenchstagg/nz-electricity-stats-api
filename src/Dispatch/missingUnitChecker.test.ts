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
			unitsNotInDispatchList: []
		});
	});

	it('should return an empty array if there are no missing units', async () => {
		mockedGetGenerators.mockResolvedValue([{
			units: [
				{
					node: '1234567890'
				}
			]
		}]);

		const result = await checkForMissingUnits(['1234567890']);
		expect(result).toEqual({
			unitsNotInDispatchList: []
		});
	});

	it('should return an array of missing units if there are missing units', async () => {
		mockedGetGenerators.mockResolvedValue([{
			units: [
				{
					node: '1234567890'
				}
			]
		}]);

		const result = await checkForMissingUnits([]);
		expect(result).toEqual({
			unitsNotInDispatchList: ['1234567890']
		});
	});
});