import { schedule } from '@gallofeliz/scheduler'
import { BeewiDeviceReader } from '@gallofeliz/beewi-reader'
import { createLogger, Logger } from '@gallofeliz/logger'
import { EcoforestStove, StoveSummary as EcoforestStoveSummary } from '@gallofeliz/ecoforest-stove'
import { NeDbDocumentCollection } from '@gallofeliz/documents-collection'
// import { createFilePersistantObject } from '@gallofeliz/persistant-object'

interface StoveSummary extends EcoforestStoveSummary {
    measuredRoomTemperature: number
}

interface DatedStoveSummary extends StoveSummary {
    _id: string
    date: Date
}

class Stove extends EcoforestStove {
    protected temperatureSensor: BeewiDeviceReader

    public constructor({logger}: {logger: Logger}) {
        super()
        this.temperatureSensor = new BeewiDeviceReader({
            device: 'hci0',
            hmac: '20:91:48:48:E5:96',
            logger
        })
    }

    public async getSummary(): Promise<StoveSummary> {
        const [originalSummary, {temperature}] = await Promise.all([
            super.getSummary(),
            this.temperatureSensor.read()
        ])
        return {
            ...originalSummary,
            measuredRoomTemperature: temperature
        }
    }
}

(async () => {
    const logger = createLogger()
    const stove = new Stove({logger})
    const iaData = new NeDbDocumentCollection<DatedStoveSummary>({
        filePath: __dirname + '/ia-data.db'
    })
    const state: Partial<{idealPower: number}> = {} /* await createFilePersistantObject<{idealPower: number}>({
        filename: __dirname + '/state.json',
        logger
    })*/

    schedule({
        onError(e) {
            logger.error(e.message, {e})
        },
        when: {
            times: ['PT5M']
        },
        async fn() {
            const stoveSummary = await stove.getSummary()

            if (stoveSummary.status !== 'running') {
                return
            }

            iaData.insert({date: new Date, ...stoveSummary})

            if (!state.idealPower) {
                state.idealPower = Math.ceil(stoveSummary.configuredMaxPower / 2)
            }

            const configuredTemperatureRange = {
                min: stoveSummary.configuredTemperature - 1, // Put max
                ideal: stoveSummary.configuredTemperature, // Try to find the good power
                max: stoveSummary.configuredTemperature + 1 // Put min
            }

            if (stoveSummary.measuredRoomTemperature >= configuredTemperatureRange.max) {
                if (stoveSummary.configuredPower !== 1) {
                    state.idealPower--
                    if (state.idealPower < 1) {
                        state.idealPower = 1
                    }
                    logger.info('Temperature too hight, putting at minimum. Reducing idealPower, new value ' + state.idealPower)
                    stove.configurePower(1)
                }
            } else if (stoveSummary.measuredRoomTemperature < configuredTemperatureRange.min) {
                if (stoveSummary.configuredPower !== stoveSummary.configuredMaxPower) {
                    state.idealPower++
                    if (state.idealPower > stoveSummary.configuredMaxPower) {
                        state.idealPower = stoveSummary.configuredMaxPower
                    }
                    logger.info('Temperature too low, putting at maximum. Increasing idealPower, new value ' + state.idealPower)
                    stove.configurePower(stoveSummary.configuredMaxPower)
                }
            } else {
                if (stoveSummary.configuredPower !== state.idealPower) {
                    logger.info('Temperature correct, putting idealPower ' + state.idealPower)
                    stove.configurePower(state.idealPower)
                }
            }


            // Todo analyse iaData and adjust state.idealPower ; only if running stove
            // on constant burnTemperature, and near of idealTemperature, and analyze
            // if temperature goes down, up or straight forward
            // iaData.find({ date < 2h },{ sort: {date: -1}, limit: 10})


        }
    })

})()
