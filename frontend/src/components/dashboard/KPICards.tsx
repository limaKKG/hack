import { Card, Col, Row, Statistic, Typography, Segmented } from 'antd'
import {
  TeamOutlined,
  HeartOutlined,
  FallOutlined,
  SwapOutlined,
  RiseOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useState, useMemo } from 'react'
import {
  fetchDemographicsSummary,
  fetchDemographicsTimeseries,
  fetchPopulationSummary,
  fetchPopulationTimeseries,
} from '@/api/population'
import { useFilterStore } from '@/store/useFilterStore'
import { formatDelta, formatPopulation, formatRate } from '@/utils/formatters'

function DeltaHint({
  value,
  formatter,
  positiveIsGood = true,
}: {
  value: number | null | undefined
  formatter: (value: number | null | undefined) => string
  positiveIsGood?: boolean
}) {
  if (value == null) {
    return <Typography.Text type="secondary">Нет сравнения</Typography.Text>
  }

  const color =
    value === 0
      ? '#718096'
      : positiveIsGood
        ? value > 0 ? '#237804' : '#cf1322'
        : value > 0 ? '#cf1322' : '#237804'

  return (
    <Typography.Text style={{ color, fontSize: 12 }}>
      к прошлому году: {formatter(value)}
    </Typography.Text>
  )
}

export default function KPICards() {
  const { municipalityId, regionId, yearFrom, yearTo } = useFilterStore()
  const previousYear = yearTo > yearFrom ? yearTo - 1 : null
  const yearTo2 = yearTo - 2
  const [valueMode, setValueMode] = useState<'absolute' | 'percent'>('absolute')

  // Запросы для региона (без изменений)
  const { data: popSummary } = useQuery({
    queryKey: ['populationSummary', yearTo, regionId],
    queryFn: () => fetchPopulationSummary({ year: yearTo, region_id: regionId ?? undefined }),
    enabled: !municipalityId,
  })

  const { data: previousPopSummary } = useQuery({
    queryKey: ['populationSummary', previousYear, regionId],
    queryFn: () => fetchPopulationSummary({ year: previousYear!, region_id: regionId ?? undefined }),
    enabled: !municipalityId && previousYear != null,
  })

  const { data: popSummaryYear2 } = useQuery({
    queryKey: ['populationSummary', yearTo2, regionId],
    queryFn: () => fetchPopulationSummary({ year: yearTo2, region_id: regionId ?? undefined }),
    enabled: !municipalityId && yearTo2 >= yearFrom,
  })

  const { data: demoSummary } = useQuery({
    queryKey: ['demographicsSummary', yearTo, regionId],
    queryFn: () => fetchDemographicsSummary({ year: yearTo, region_id: regionId ?? undefined }),
    enabled: !municipalityId,
  })

  const { data: previousDemoSummary } = useQuery({
    queryKey: ['demographicsSummary', previousYear, regionId],
    queryFn: () => fetchDemographicsSummary({ year: previousYear!, region_id: regionId ?? undefined }),
    enabled: !municipalityId && previousYear != null,
  })

  // Запрос для муниципалитетов – теперь начинаем с года, который покрывает yearTo-2 (если он в диапазоне)
  const municipalityStartYear = yearTo2 >= yearFrom ? yearTo2 : (previousYear ?? yearTo)

  const { data: municipalityPopulationSeries = [] } = useQuery({
    queryKey: ['kpiPopulationTimeseries', municipalityId, municipalityStartYear, yearTo],
    queryFn: () =>
      fetchPopulationTimeseries({
        municipality_id: municipalityId ? [municipalityId] : [],
        year_from: municipalityStartYear,
        year_to: yearTo,
      }),
    enabled: !!municipalityId,
  })

  const { data: municipalityDemographicsSeries = [] } = useQuery({
    queryKey: ['kpiDemographicsTimeseries', municipalityId, previousYear, yearTo],
    queryFn: () =>
      fetchDemographicsTimeseries({
        municipality_id: municipalityId ? [municipalityId] : [],
        year_from: previousYear ?? yearTo,
        year_to: yearTo,
      }),
    enabled: !!municipalityId,
  })

  const populationSeries = municipalityPopulationSeries[0]?.data ?? []
  const demographicsSeries = municipalityDemographicsSeries[0]?.data ?? []

  const currentPopulationPoint = populationSeries.find((point) => point.year === yearTo)
  const previousPopulationPoint =
    previousYear == null ? undefined : populationSeries.find((point) => point.year === previousYear)
  const populationPointYear2 = populationSeries.find((point) => point.year === yearTo2)

  const currentDemographicsPoint = demographicsSeries.find((point) => point.year === yearTo)
  const previousDemographicsPoint =
    previousYear == null ? undefined : demographicsSeries.find((point) => point.year === previousYear)

  // Значения населения
  const populationValue = municipalityId ? currentPopulationPoint?.population : popSummary?.total_population
  const previousPopulation = municipalityId
    ? previousPopulationPoint?.population
    : previousPopSummary?.total_population
  const populationYear2 = municipalityId
    ? populationPointYear2?.population
    : popSummaryYear2?.total_population

  // Абсолютное изменение
  const populationDelta = municipalityId
    ? currentPopulationPoint?.population != null && previousPopulationPoint?.population != null
      ? currentPopulationPoint.population - previousPopulationPoint.population
      : null
    : popSummary?.total_population != null && previousPopSummary?.total_population != null
      ? popSummary.total_population - previousPopSummary.total_population
      : null

  // Процентное изменение за последний год
  const populationDeltaPercent = populationValue != null && previousPopulation != null
    ? ((populationValue - previousPopulation) / previousPopulation) * 100
    : null

  // Предыдущее процентное изменение (год назад)
  const previousPopulationDeltaPercent = previousPopulation != null && populationYear2 != null
    ? ((previousPopulation - populationYear2) / populationYear2) * 100
    : null

  // Дельта процентных изменений (в п.п.)
  const populationDeltaPercentDelta = (populationDeltaPercent != null && previousPopulationDeltaPercent != null)
    ? populationDeltaPercent - previousPopulationDeltaPercent
    : null

  // ... остальные вычисления без изменений
  const naturalGrowthValue = municipalityId ? currentDemographicsPoint?.natural_growth : demoSummary?.total_natural_growth
  const previousNaturalGrowth = municipalityId
    ? previousDemographicsPoint?.natural_growth
    : previousDemoSummary?.total_natural_growth

  const birthRateValue = municipalityId ? currentDemographicsPoint?.birth_rate : demoSummary?.avg_birth_rate
  const previousBirthRate = municipalityId
    ? previousDemographicsPoint?.birth_rate
    : previousDemoSummary?.avg_birth_rate

  const deathRateValue = municipalityId ? currentDemographicsPoint?.death_rate : demoSummary?.avg_death_rate
  const previousDeathRate = municipalityId
    ? previousDemographicsPoint?.death_rate
    : previousDemoSummary?.avg_death_rate

  const migrationValue = municipalityId ? currentDemographicsPoint?.net_migration : demoSummary?.total_net_migration
  const previousMigration = municipalityId
    ? previousDemographicsPoint?.net_migration
    : previousDemoSummary?.total_net_migration

  const birthsAbsolute = birthRateValue != null && populationValue != null
    ? (birthRateValue * populationValue) / 1000
    : null
  const previousBirthsAbsolute = previousBirthRate != null && previousPopulation != null
    ? (previousBirthRate * previousPopulation) / 1000
    : null

  const deathsAbsolute = deathRateValue != null && populationValue != null
    ? (deathRateValue * populationValue) / 1000
    : null
  const previousDeathsAbsolute = previousDeathRate != null && previousPopulation != null
    ? (previousDeathRate * previousPopulation) / 1000
    : null

  const birthRatePercent = birthRateValue != null ? birthRateValue / 10 : null
  const previousBirthRatePercent = previousBirthRate != null ? previousBirthRate / 10 : null
  const deathRatePercent = deathRateValue != null ? deathRateValue / 10 : null
  const previousDeathRatePercent = previousDeathRate != null ? previousDeathRate / 10 : null

  const naturalGrowthPercent = naturalGrowthValue != null && populationValue != null
    ? (naturalGrowthValue / populationValue) * 100
    : null
  const prevNaturalGrowthPercent = previousNaturalGrowth != null && previousPopulation != null
    ? (previousNaturalGrowth / previousPopulation) * 100
    : null

  const migrationPercent = migrationValue != null && populationValue != null
    ? (migrationValue / populationValue) * 100
    : null
  const prevMigrationPercent = previousMigration != null && previousPopulation != null
    ? (previousMigration / previousPopulation) * 100
    : null

  const cards = useMemo(() => {
    const isPercent = valueMode === 'percent'

    return [
      {
        title: 'Население',
        value: isPercent ? populationDeltaPercent : populationValue,
        formatter: isPercent
          ? (v: number | null) => (v != null ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '—')
          : formatPopulation,
        delta: isPercent ? populationDeltaPercentDelta : populationDelta,
        deltaFormatter: isPercent
          ? (v: number | null | undefined) => v != null ? `${v > 0 ? '+' : ''}${v.toFixed(2)} п.п.` : '—'
          : (v: number | null | undefined) => formatDelta(v),
        positiveIsGood: true,
        icon: <TeamOutlined style={{ color: '#2b6cb0' }} />,
        color: '#ebf8ff',
      },
      // ... остальные карточки без изменений ...
      {
        title: 'Ест. прирост',
        value: isPercent ? naturalGrowthPercent : naturalGrowthValue,
        formatter: isPercent
          ? (v: number | null) => (v != null ? `${v.toFixed(2)}%` : '—')
          : formatPopulation,
        delta: isPercent
          ? (naturalGrowthPercent != null && prevNaturalGrowthPercent != null
            ? naturalGrowthPercent - prevNaturalGrowthPercent
            : null)
          : (municipalityId
            ? naturalGrowthValue != null && previousNaturalGrowth != null
              ? naturalGrowthValue - previousNaturalGrowth
              : null
            : naturalGrowthValue != null && previousNaturalGrowth != null
              ? naturalGrowthValue - previousNaturalGrowth
              : null),
        deltaFormatter: isPercent
          ? (v: number | null | undefined) => v != null ? `${v > 0 ? '+' : ''}${v.toFixed(2)} п.п.` : '—'
          : (v: number | null | undefined) => formatDelta(v),
        positiveIsGood: true,
        icon: <RiseOutlined style={{ color: '#38a169' }} />,
        color: '#f0fff4',
      },
      {
        title: 'Рождаемость',
        value: isPercent ? birthRatePercent : birthsAbsolute,
        formatter: isPercent
          ? (v: number | null) => (v != null ? `${v.toFixed(2)}%` : '—')
          : formatPopulation,
        delta: isPercent
          ? (birthRatePercent != null && previousBirthRatePercent != null
            ? birthRatePercent - previousBirthRatePercent
            : null)
          : (birthsAbsolute != null && previousBirthsAbsolute != null
            ? birthsAbsolute - previousBirthsAbsolute
            : null),
        deltaFormatter: isPercent
          ? (v: number | null | undefined) => v != null ? `${v > 0 ? '+' : ''}${v.toFixed(2)} п.п.` : '—'
          : (v: number | null | undefined) => formatDelta(v),
        positiveIsGood: true,
        icon: <HeartOutlined style={{ color: '#d69e2e' }} />,
        color: '#fffbe6',
      },
      {
        title: 'Смертность',
        value: isPercent ? deathRatePercent : deathsAbsolute,
        formatter: isPercent
          ? (v: number | null) => (v != null ? `${v.toFixed(2)}%` : '—')
          : formatPopulation,
        delta: isPercent
          ? (deathRatePercent != null && previousDeathRatePercent != null
            ? deathRatePercent - previousDeathRatePercent
            : null)
          : (deathsAbsolute != null && previousDeathsAbsolute != null
            ? deathsAbsolute - previousDeathsAbsolute
            : null),
        deltaFormatter: isPercent
          ? (v: number | null | undefined) => v != null ? `${v > 0 ? '+' : ''}${v.toFixed(2)} п.п.` : '—'
          : (v: number | null | undefined) => formatDelta(v),
        positiveIsGood: false,
        icon: <FallOutlined style={{ color: '#e53e3e' }} />,
        color: '#fff1f0',
      },
      {
        title: 'Миграция',
        value: isPercent ? migrationPercent : migrationValue,
        formatter: isPercent
          ? (v: number | null) => (v != null ? `${v.toFixed(2)}%` : '—')
          : formatPopulation,
        delta: isPercent
          ? (migrationPercent != null && prevMigrationPercent != null
            ? migrationPercent - prevMigrationPercent
            : null)
          : (municipalityId
            ? migrationValue != null && previousMigration != null
              ? migrationValue - previousMigration
              : null
            : migrationValue != null && previousMigration != null
              ? migrationValue - previousMigration
              : null),
        deltaFormatter: isPercent
          ? (v: number | null | undefined) => v != null ? `${v > 0 ? '+' : ''}${v.toFixed(2)} п.п.` : '—'
          : (v: number | null | undefined) => formatDelta(v),
        positiveIsGood: true,
        icon: <SwapOutlined style={{ color: '#805ad5' }} />,
        color: '#f9f0ff',
      },
    ]
  }, [
    valueMode,
    populationValue,
    populationDelta,
    populationDeltaPercent,
    populationDeltaPercentDelta,
    naturalGrowthValue,
    naturalGrowthPercent,
    prevNaturalGrowthPercent,
    previousNaturalGrowth,
    birthsAbsolute,
    previousBirthsAbsolute,
    birthRatePercent,
    previousBirthRatePercent,
    deathsAbsolute,
    previousDeathsAbsolute,
    deathRatePercent,
    previousDeathRatePercent,
    migrationValue,
    migrationPercent,
    prevMigrationPercent,
    previousMigration,
    municipalityId,
  ])

  return (
    <Card
      title="Ключевые показатели"
      extra={
        <Segmented
          value={valueMode}
          onChange={(val) => setValueMode(val as 'absolute' | 'percent')}
          options={[
            { label: 'Абсолютные', value: 'absolute' },
            { label: 'Проценты', value: 'percent' },
          ]}
        />
      }
      style={{ marginBottom: 16 }}
    >
      <Row gutter={[32, 16]}>
        {cards.map((card) => (
          <Col key={card.title} flex="1" style={{ minWidth: 0 }}>
            <Card
              size="small"
              style={{ background: card.color, borderColor: 'transparent' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Statistic
                    title={card.title}
                    value={card.value != null ? card.formatter(card.value as number) : '—'}
                    valueStyle={{ fontSize: 22, fontWeight: 600 }}
                  />
                  <DeltaHint
                    value={card.delta}
                    formatter={card.deltaFormatter!}
                    positiveIsGood={card.positiveIsGood}
                  />
                </div>
                <div style={{ fontSize: 24, opacity: 0.6, flexShrink: 0 }}>{card.icon}</div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </Card>
  )
}
