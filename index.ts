import { schedule } from '@gallofeliz/scheduler'
import { BeewiDeviceReader } from '@gallofeliz/beewi-reader'
import { createLogger, Logger } from '@gallofeliz/logger'
import { EcoforestStove, StoveSummary as EcoforestStoveSummary } from '@gallofeliz/ecoforest-stove'
import { NeDbDocumentCollection } from '@gallofeliz/documents-collection'
// import { createFilePersistantObject } from '@gallofeliz/persistant-object'

interface History {
    _id: string
    date: Date
    stoveSummary: EcoforestStoveSummary
    measuredRoomTemperature: number
    previousIdealPower: number
    computedIdealPower: number
    applyedConfiguredPower: number | null
    configuredPowerApplyedChangeReason: string | null
    idealPowerComputeChangeReason: string | null
    recentMetricsStats?: object
    maxPower: number
    applyedConfiguredConvertorSpeedModifier: number | null
    configuredConvertorSpeedModifierChangeReason: string | null
}

// class Stove extends EcoforestStove {
//     protected temperatureSensor: BeewiDeviceReader

//     public constructor({logger}: {logger: Logger}) {
//         super()
//         this.temperatureSensor =
//     }

//     public async getSummary(): Promise<StoveSummary> {
//         const [originalSummary, {temperature}] = await Promise.all([
//             super.getSummary(),
//             this.temperatureSensor.read()
//         ])
//         return {
//             ...originalSummary,
//             measuredRoomTemperature: temperature - 0.6 /* To fit with my own thermometre ? Can be calibration with 2 points */
//         }
//     }
// }

(async () => {
    const logger = createLogger()
    const stove = new EcoforestStove()
    const iaData = new NeDbDocumentCollection<History>({
        filePath: __dirname + '/ia-data.db'
    })
    const temperatureSensor = new BeewiDeviceReader({
        device: 'hci0',
        hmac: '20:91:48:48:E5:96',
        logger
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
                state.idealPower = 1 //Math.ceil(maxPower / 2) - 1
                if(stoveSummary.configuredPower !== 1) {
                    stove.configurePower(1)
                }
                if (stoveSummary.configuredConvectorSpeedModifierPct !== 0) {
                    stove.configureConvectorSpeedModifier(0)
                }
                return
            }

            const {temperature: measuredRoomTemperature, battery: temperatureSensorBattery} = await temperatureSensor.read()
                .then(d => ({...d, temperature: d.temperature - 0.6}))

            if (!state.idealPower) {
                state.idealPower = 1 //Math.ceil(maxPower / 2) - 1
            }

            const originalIdealPower = state.idealPower

            const configuredTemperatureRange = {
                min: stoveSummary.configuredTemperature - 1, // Put max
                ideal: stoveSummary.configuredTemperature, // Try to find the good power
                max: stoveSummary.configuredTemperature + 1 // Put min
            }

            const nowHistoryPartial = {
                date: new Date,
                stoveSummary,
                measuredRoomTemperature,
                temperatureSensorBattery
            }

            const recentMetricsStats = await analyzeRecentStats(nowHistoryPartial)

            let applyedConfiguredPower: number | null = null
            let configuredPowerApplyedChangeReason: string | null = null
            let idealPowerComputeChangeReason: string | null = null

            const maxPower = measuredRoomTemperature < configuredTemperatureRange.min - 3
                ? 7
                : 5

            if (measuredRoomTemperature >= configuredTemperatureRange.max) {
                if (stoveSummary.configuredPower !== 1) {
                    state.idealPower--
                    if (state.idealPower < 1) {
                        state.idealPower = 1
                    } else {
                        idealPowerComputeChangeReason = 'measuredTemp-too-high-decrease-idealPower'
                    }
                    //logger.info('Temperature too hight, putting at minimum. Reducing idealPower, new value ' + state.idealPower)
                    stove.configurePower(1)
                    applyedConfiguredPower = 1
                    configuredPowerApplyedChangeReason = 'measuredTemp-too-high'
                }
            } else if (measuredRoomTemperature < configuredTemperatureRange.min) {
                if (stoveSummary.configuredPower !== maxPower) {
                    state.idealPower++
                    if (state.idealPower > maxPower) {
                        state.idealPower = maxPower
                    } else {
                        idealPowerComputeChangeReason = 'measuredTemp-too-low-increase-idealPower'
                    }
                    //logger.info('Temperature too low, putting at maximum. Increasing idealPower, new value ' + state.idealPower)
                    stove.configurePower(maxPower)
                    applyedConfiguredPower = maxPower
                    configuredPowerApplyedChangeReason = 'measuredTemp-too-low'
                }
            } else {
                if (recentMetricsStats?.burnTemperatureTrend === 'stable' && recentMetricsStats?.configuredPowerTrend === 'stable') {
                    if (recentMetricsStats.measuredTemperatureTrend === 'increase') {
                        if (state.idealPower > 1) {
                            state.idealPower--
                            idealPowerComputeChangeReason = 'measuredTemp-increases'
                        }
                    } else if (recentMetricsStats.measuredTemperatureTrend === 'decrease') {
                        if (state.idealPower < maxPower) {
                            state.idealPower++
                            idealPowerComputeChangeReason = 'measuredTemp-decreases'
                        }
                    }
                }

                if (stoveSummary.configuredPower !== state.idealPower) {
                    //logger.info('Temperature correct, putting idealPower ' + state.idealPower)
                    stove.configurePower(state.idealPower)
                    applyedConfiguredPower = state.idealPower
                    configuredPowerApplyedChangeReason = 'measuredTemp-normal-apply-idealPower'
                }
            }

            let applyedConfiguredConvertorSpeedModifier: number | null = null
            let configuredConvertorSpeedModifierChangeReason: string | null = null
            const newConfiguredPower = applyedConfiguredPower || stoveSummary.configuredPower

            // TODO : use gaz temp instead ?

            if (newConfiguredPower === 1 && measuredRoomTemperature >= configuredTemperatureRange.ideal) {
                applyedConfiguredConvertorSpeedModifier = -15
                configuredConvertorSpeedModifierChangeReason = 'peace'
            } else if (measuredRoomTemperature < configuredTemperatureRange.min) {
                applyedConfiguredConvertorSpeedModifier = 15
                configuredConvertorSpeedModifierChangeReason = 'gogogo'
            } else {
                applyedConfiguredConvertorSpeedModifier = 0
                configuredConvertorSpeedModifierChangeReason = 'normal'
            }

            if (applyedConfiguredConvertorSpeedModifier !== stoveSummary.configuredConvectorSpeedModifierPct) {
                stove.configureConvectorSpeedModifier(applyedConfiguredConvertorSpeedModifier)
            } else {
                applyedConfiguredConvertorSpeedModifier = null
                configuredConvertorSpeedModifierChangeReason = null
            }

            // Except for sensors, this is log and should go in logs
            const history = {
                ...nowHistoryPartial,
                previousIdealPower: originalIdealPower,
                maxPower,
                computedIdealPower: state.idealPower,
                idealPowerComputeChangeReason,
                applyedConfiguredPower,
                configuredPowerApplyedChangeReason,
                applyedConfiguredConvertorSpeedModifier,
                configuredConvertorSpeedModifierChangeReason,
                recentMetricsStats
            }

            iaData.insert(history)

            console.log('history', history)

            if (stoveSummary.configuredPower === 1 && measuredRoomTemperature > configuredTemperatureRange.max) {
                if (
                    ['stable', 'increase'].includes(recentMetricsStats?.measuredTemperatureTrend || '')
                    && ['stable', 'increase'].includes(recentMetricsStats?.configuredPowerTrend || '')
                    && ['stable', 'increase'].includes(recentMetricsStats?.burnTemperatureTrend || '')
                ) {
                    logger.warning('Overheat')
                }
            }

            if (stoveSummary.configuredPower === maxPower && measuredRoomTemperature < configuredTemperatureRange.min) {
                if (
                    ['stable', 'decrease'].includes(recentMetricsStats?.measuredTemperatureTrend || '')
                    && ['stable', 'decrease'].includes(recentMetricsStats?.configuredPowerTrend || '')
                    && ['stable', 'decrease'].includes(recentMetricsStats?.burnTemperatureTrend || '')
                ) {
                    logger.warning('Underheat')
                }
            }

            console.log('recentMetricsStats', recentMetricsStats)

        }
    })

async function analyzeRecentStats(last: Pick<History, 'stoveSummary' | 'measuredRoomTemperature' | 'date'>) {
    const metrics: Pick<History, 'stoveSummary' | 'measuredRoomTemperature' | 'date'>[] =
    await (iaData.find(
        {date: { $gte: new Date((new Date).getTime() - 1000*60*16) }},
        {sort: {date: 1}}
    )).toArray() as History[]
    metrics.push(last)

    console.log('metrics', metrics)

    if (metrics.length < 2) {
        return
    }

    const duration = metrics[metrics.length - 1].date.getTime() - metrics[0].date.getTime()
    console.log('Metrics analyzing on ' + Math.round(duration / 1000 / 60) + ' minutes')

    if (duration < 1000*60*10) {
        return
    }


    return {
        measuredTemperatureTrend: trend(metrics.map(m => m.measuredRoomTemperature), 0.1, 0.1),
        configuredPowerTrend: trend(metrics.map(m => m.stoveSummary.configuredPower), 0, 0),
        burnTemperatureTrend: trend(metrics.map(m => m.stoveSummary.burnTemperature), 30, 30)
    }
}

})()

function trend(values: number[], stabilityThreshold: number, trendThreshold: number) {

    const variations = values.map((value, index) => {
        if (index === 0) {
            return
        }

        if (Math.abs(value - values[index-1]) <= stabilityThreshold) {
            return 'stable'
        }

        return value - values[index-1] > 0 ? 'increase' : 'descrease'
    })

    const instable = variations.includes('increase') && variations.includes('descrease')

    if (instable) {
        return 'instable'
    }

    const diff = values[values.length - 1] - values[0]

    if (Math.abs(diff) <= trendThreshold) {
        return 'stable'
    }

    if (diff < 0) {
        return 'decrease'
    }

    return 'increase'
}
