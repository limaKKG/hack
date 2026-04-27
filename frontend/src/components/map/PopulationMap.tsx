import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Col, Drawer, List, Row, Segmented, Select, Space, Spin, Statistic, Tag, Typography, message } from 'antd'
import { BulbOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import type { DrawingStyle, YMap, YMapFeature, YMapFeatureProps, YMapLocationRequest } from 'ymaps3'
import { fetchMapGeoJSON, fetchMunicipalitiesByRegion } from '@/api/population'
import { getAIInsight } from '@/api/chat'
import { loadYandexMapsApi } from '@/lib/yandexMaps'
import { getDensityColor, getGrowthColor } from '@/utils/colors'
import { formatArea, formatDensity, formatPopulation } from '@/utils/formatters'

const DEFAULT_LOCATION: YMapLocationRequest = {
  center: [95, 62],
  zoom: 3,
}

const MAP_SOURCE_ID = 'population-regions-source'
const ANTIMERIDIAN_EPSILON = 0.000001
const MAP_YEARS = Array.from({ length: 13 }, (_, index) => 2022 - index)
const PERIOD_YEARS = [...MAP_YEARS].sort((left, right) => left - right)

type MapLevel = 'region' | 'municipality'
type MapMetric = 'density' | 'change_percent'
type MapBounds = [[number, number], [number, number]]
type MapPoint = [number, number]
type PolygonCoordinates = MapPoint[][]
type MultiPolygonCoordinates = PolygonCoordinates[]

type RegionProperties = {
  db_id?: number
  db_name?: string
  name?: string
  NAME_1?: string
  population?: number
  density?: number | null
  area_sq_km?: number | null
  population_start?: number | null
  population_end?: number | null
  change_percent?: number | null
  year_from?: number | null
  year_to?: number | null
  [key: string]: unknown
}

type MapFeature = {
  type: 'Feature'
  geometry: YMapFeatureProps['geometry'] | { type: string; coordinates: unknown }
  properties?: RegionProperties
}

type FeatureCollection = {
  type: 'FeatureCollection'
  features?: MapFeature[]
}

type RegionSelection = {
  key: string
  name: string
  population: number
  density: number | null
  areaSqKm: number | null
  populationStart: number | null
  populationEnd: number | null
  changePercent: number | null
  yearFrom: number | null
  yearTo: number | null
  dbId: number | null
  hasCoverage: boolean
  focusLocation: YMapLocationRequest | null
}

type RegionEntity = {
  key: string
  region: RegionSelection
  entities: YMapFeature[]
}

function getRegionKey(properties: RegionProperties, fallback: number) {
  if (typeof properties.db_id === 'number') {
    return `region-${properties.db_id}`
  }

  const name = properties.db_name || properties.name || properties.NAME_1
  return name ? `region-${name}` : `region-fallback-${fallback}`
}

function getRegionName(properties: RegionProperties) {
  return properties.db_name || properties.name || properties.NAME_1 || 'Неизвестно'
}

function getRegionPopulation(properties: RegionProperties) {
  return typeof properties.population === 'number' ? properties.population : 0
}

function getRegionDensity(properties: RegionProperties) {
  return typeof properties.density === 'number' ? properties.density : null
}

function getRegionAreaSqKm(properties: RegionProperties) {
  return typeof properties.area_sq_km === 'number' ? properties.area_sq_km : null
}

function getRegionPopulationStart(properties: RegionProperties) {
  return typeof properties.population_start === 'number' ? properties.population_start : null
}

function getRegionPopulationEnd(properties: RegionProperties) {
  return typeof properties.population_end === 'number' ? properties.population_end : null
}

function getRegionChangePercent(properties: RegionProperties) {
  return typeof properties.change_percent === 'number' ? properties.change_percent : null
}

function getRegionYearFrom(properties: RegionProperties) {
  return typeof properties.year_from === 'number' ? properties.year_from : null
}

function getRegionYearTo(properties: RegionProperties) {
  return typeof properties.year_to === 'number' ? properties.year_to : null
}

function formatMunicipalityType(value: string) {
  return value.split('_').join(' ')
}

function formatChangePercent(value: number | null) {
  if (value == null) {
    return 'Нет данных'
  }

  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`
}

function extendBounds(coordinates: unknown, acc: { minLng: number; minLat: number; maxLng: number; maxLat: number }) {
  if (!Array.isArray(coordinates)) {
    return
  }

  if (
    coordinates.length === 2 &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number'
  ) {
    const [lng, lat] = coordinates as [number, number]
    acc.minLng = Math.min(acc.minLng, lng)
    acc.minLat = Math.min(acc.minLat, lat)
    acc.maxLng = Math.max(acc.maxLng, lng)
    acc.maxLat = Math.max(acc.maxLat, lat)
    return
  }

  coordinates.forEach((item) => extendBounds(item, acc))
}

function collectCoordinates(
  coordinates: unknown,
  acc: { longitudes: number[]; latitudes: number[] }
) {
  if (!Array.isArray(coordinates)) {
    return
  }

  if (
    coordinates.length === 2 &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number'
  ) {
    const [lng, lat] = coordinates as [number, number]
    acc.longitudes.push(lng)
    acc.latitudes.push(lat)
    return
  }

  coordinates.forEach((item) => collectCoordinates(item, acc))
}

function normalizeLongitude(lng: number) {
  const normalized = ((lng + 180) % 360 + 360) % 360 - 180
  return normalized === -180 && lng > 0 ? 180 : normalized
}

function getSpan(values: number[]) {
  return Math.max(...values) - Math.min(...values)
}

function estimateZoomFromSpan(spanLng: number, spanLat: number) {
  const span = Math.max(spanLng, spanLat * 1.4)

  if (span > 80) return 2
  if (span > 45) return 2.7
  if (span > 28) return 3.3
  if (span > 16) return 4.1
  if (span > 9) return 4.9
  if (span > 5) return 5.7

  return 6.5
}

function getGeometryBounds(geometry: MapFeature['geometry']): MapBounds | null {
  const acc = {
    minLng: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
  }

  extendBounds(geometry.coordinates, acc)

  if (
    !Number.isFinite(acc.minLng) ||
    !Number.isFinite(acc.minLat) ||
    !Number.isFinite(acc.maxLng) ||
    !Number.isFinite(acc.maxLat)
  ) {
    return null
  }

  return [
    [acc.minLng, acc.minLat],
    [acc.maxLng, acc.maxLat],
  ]
}

function getGeometryFocusLocation(geometry: MapFeature['geometry']): YMapLocationRequest | null {
  const coordinates = { longitudes: [] as number[], latitudes: [] as number[] }
  collectCoordinates(geometry.coordinates, coordinates)

  if (!coordinates.longitudes.length || !coordinates.latitudes.length) {
    return null
  }

  const rawLongitudes = coordinates.longitudes
  const wrappedLongitudes = rawLongitudes.map((lng) => (lng < 0 ? lng + 360 : lng))
  const rawSpan = getSpan(rawLongitudes)
  const wrappedSpan = getSpan(wrappedLongitudes)
  const minLat = Math.min(...coordinates.latitudes)
  const maxLat = Math.max(...coordinates.latitudes)

  if (wrappedSpan + 0.001 < rawSpan && wrappedSpan <= 180) {
    const minLng = Math.min(...wrappedLongitudes)
    const maxLng = Math.max(...wrappedLongitudes)
    return {
      center: [normalizeLongitude((minLng + maxLng) / 2), (minLat + maxLat) / 2],
      zoom: estimateZoomFromSpan(wrappedSpan, maxLat - minLat),
    }
  }

  const bounds = getGeometryBounds(geometry)
  if (!bounds) {
    return null
  }

  return { bounds }
}

function sanitizeLongitude(lng: number) {
  if (lng >= 180) {
    return 180 - ANTIMERIDIAN_EPSILON
  }

  if (lng <= -180) {
    return -180 + ANTIMERIDIAN_EPSILON
  }

  return lng
}

function normalizeRing(ring: MapPoint[]): MapPoint[] {
  return ring.map(([lng, lat]) => [sanitizeLongitude(lng), lat])
}

function normalizePolygonCoordinates(coordinates: PolygonCoordinates): PolygonCoordinates {
  return coordinates.map((ring) => normalizeRing(ring))
}

function splitGeometryForMap(geometry: YMapFeatureProps['geometry']): YMapFeatureProps['geometry'][] {
  if (geometry.type === 'Polygon') {
    return [
      {
        type: 'Polygon',
        coordinates: normalizePolygonCoordinates(geometry.coordinates as PolygonCoordinates),
      } as YMapFeatureProps['geometry'],
    ]
  }

  return (geometry.coordinates as MultiPolygonCoordinates).map((polygonCoordinates) => ({
    type: 'Polygon',
    coordinates: normalizePolygonCoordinates(polygonCoordinates),
  })) as YMapFeatureProps['geometry'][]
}

function toRegionSelection(properties: RegionProperties, geometry: MapFeature['geometry'], fallback: number): RegionSelection {
  const hasCoverage = typeof properties.db_id === 'number'

  return {
    key: getRegionKey(properties, fallback),
    name: getRegionName(properties),
    population: getRegionPopulation(properties),
    density: getRegionDensity(properties),
    areaSqKm: getRegionAreaSqKm(properties),
    populationStart: getRegionPopulationStart(properties),
    populationEnd: getRegionPopulationEnd(properties),
    changePercent: getRegionChangePercent(properties),
    yearFrom: getRegionYearFrom(properties),
    yearTo: getRegionYearTo(properties),
    dbId: hasCoverage ? properties.db_id ?? null : null,
    hasCoverage,
    focusLocation: getGeometryFocusLocation(geometry),
  }
}

function findRegionSelectionByKey(features: MapFeature[] | undefined, key: string) {
  if (!features?.length) {
    return null
  }

  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index]
    if (!feature.properties || !isMapGeometry(feature.geometry)) {
      continue
    }

    const region = toRegionSelection(feature.properties, feature.geometry, index)
    if (region.key === key) {
      return region
    }
  }

  return null
}

function isMapGeometry(geometry: MapFeature['geometry']): geometry is YMapFeatureProps['geometry'] {
  return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'
}

function getFeatureStyle(
  region: RegionSelection,
  hovered: boolean,
  selected: boolean,
  mapLevel: MapLevel,
  mapMetric: MapMetric,
  hasFocusedRegion: boolean
): DrawingStyle {
  if (!region.hasCoverage) {
    return {
      fill: '#d9d9d9',
      fillOpacity: selected ? 0.72 : hovered ? 0.58 : 0.44,
      stroke: [
        {
          color: selected ? '#595959' : hovered ? '#8c8c8c' : '#bfbfbf',
          width: selected ? 2.5 : hovered ? 2 : 1,
          opacity: 1,
        },
      ],
      cursor: 'pointer',
      interactive: true,
      zIndex: selected ? 20 : hovered ? 10 : 1,
    }
  }

  if (mapLevel === 'municipality' && hasFocusedRegion) {
    if (selected) {
      return {
        fill: '#1677ff',
        fillOpacity: hovered ? 0.12 : 0.08,
        stroke: [
          {
            color: '#003a8c',
            width: 3,
            opacity: 1,
          },
        ],
        cursor: 'pointer',
        interactive: true,
        zIndex: 20,
      }
    }

    return {
      fill: '#ffffff',
      fillOpacity: 0,
      stroke: [
        {
          color: '#ffffff',
          width: 0.8,
          opacity: 0.38,
        },
      ],
      cursor: 'pointer',
      interactive: true,
      zIndex: hovered ? 9 : 1,
    }
  }

  if (
    (mapMetric === 'change_percent' && region.changePercent == null)
    || (mapMetric === 'density' && region.density == null)
  ) {
    return {
      fill: '#d9d9d9',
      fillOpacity: selected ? 0.72 : hovered ? 0.58 : 0.44,
      stroke: [
        {
          color: selected ? '#595959' : hovered ? '#8c8c8c' : '#bfbfbf',
          width: selected ? 2.5 : hovered ? 2 : 1,
          opacity: 1,
        },
      ],
      cursor: 'pointer',
      interactive: true,
      zIndex: selected ? 20 : hovered ? 10 : 1,
    }
  }

  return {
    fill: mapMetric === 'change_percent' ? getGrowthColor(region.changePercent ?? 0) : getDensityColor(region.density ?? 0),
    fillOpacity: selected ? 0.82 : hovered ? 0.72 : mapLevel === 'municipality' ? 0.4 : 0.58,
    stroke: [
      {
        color: selected ? '#003a8c' : hovered ? '#1677ff' : '#ffffff',
        width: selected ? 2.5 : hovered ? 2 : 1,
        opacity: 1,
      },
    ],
    cursor: 'pointer',
    interactive: true,
    zIndex: selected ? 20 : hovered ? 10 : 1,
  }
}

export default function PopulationMap() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<YMap | null>(null)
  const ymapsRef = useRef<typeof ymaps3 | null>(null)
  const regionEntitiesRef = useRef<RegionEntity[]>([])

  const [selectedRegion, setSelectedRegion] = useState<RegionSelection | null>(null)
  const [hoveredRegion, setHoveredRegion] = useState<RegionSelection | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [insightLoading, setInsightLoading] = useState(false)
  const [insight, setInsight] = useState('')
  const [mapReady, setMapReady] = useState(false)
  const [mapError, setMapError] = useState('')
  const [mapLevel, setMapLevel] = useState<MapLevel>('region')
  const [mapMetric, setMapMetric] = useState<MapMetric>('density')
  const [selectedYear, setSelectedYear] = useState(2022)
  const [yearFrom, setYearFrom] = useState(2021)
  const [yearTo, setYearTo] = useState(2022)

  const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY?.trim() || ''
  const displayYear = mapMetric === 'density' ? selectedYear : yearTo

  const { data: geojson, isLoading } = useQuery<FeatureCollection>({
    queryKey: ['map-geojson', 'region', mapMetric, displayYear, yearFrom, yearTo],
    queryFn: () =>
      fetchMapGeoJSON({
        level: 'region',
        metric: mapMetric,
        year: displayYear,
        year_from: mapMetric === 'change_percent' ? yearFrom : undefined,
        year_to: mapMetric === 'change_percent' ? yearTo : undefined,
      }),
  })

  const { data: municipalities = [], isLoading: municipalitiesLoading } = useQuery({
    queryKey: ['map-region-municipalities', selectedRegion?.dbId, displayYear],
    queryFn: () => fetchMunicipalitiesByRegion(selectedRegion!.dbId!, { year: displayYear }),
    enabled: mapLevel === 'municipality' && !!selectedRegion?.dbId,
  })

  const uncoveredRegions = (geojson?.features ?? []).filter((feature) => typeof feature.properties?.db_id !== 'number')

  useEffect(() => {
    const features = geojson?.features
    if (!features?.length) {
      return
    }

    if (selectedRegion?.key) {
      const nextSelectedRegion = findRegionSelectionByKey(features, selectedRegion.key)
      if (nextSelectedRegion) {
        setSelectedRegion((current) => {
          if (
            current?.key === nextSelectedRegion.key &&
            current.population === nextSelectedRegion.population &&
            current.density === nextSelectedRegion.density &&
            current.areaSqKm === nextSelectedRegion.areaSqKm &&
            current.populationStart === nextSelectedRegion.populationStart &&
            current.populationEnd === nextSelectedRegion.populationEnd &&
            current.changePercent === nextSelectedRegion.changePercent &&
            current.yearFrom === nextSelectedRegion.yearFrom &&
            current.yearTo === nextSelectedRegion.yearTo &&
            current.dbId === nextSelectedRegion.dbId &&
            current.hasCoverage === nextSelectedRegion.hasCoverage
          ) {
            return current
          }

          return nextSelectedRegion
        })
      }
    }

    if (hoveredRegion?.key) {
      const nextHoveredRegion = findRegionSelectionByKey(features, hoveredRegion.key)
      if (nextHoveredRegion) {
        setHoveredRegion((current) => {
          if (
            current?.key === nextHoveredRegion.key &&
            current.population === nextHoveredRegion.population &&
            current.density === nextHoveredRegion.density &&
            current.areaSqKm === nextHoveredRegion.areaSqKm &&
            current.populationStart === nextHoveredRegion.populationStart &&
            current.populationEnd === nextHoveredRegion.populationEnd &&
            current.changePercent === nextHoveredRegion.changePercent &&
            current.yearFrom === nextHoveredRegion.yearFrom &&
            current.yearTo === nextHoveredRegion.yearTo &&
            current.dbId === nextHoveredRegion.dbId &&
            current.hasCoverage === nextHoveredRegion.hasCoverage
          ) {
            return current
          }

          return nextHoveredRegion
        })
      }
    }
  }, [geojson, hoveredRegion?.key, selectedRegion?.key])

  useEffect(() => {
    setInsight('')
  }, [displayYear, mapMetric, yearFrom, yearTo])

  useEffect(() => {
    if (!apiKey || !mapContainerRef.current) {
      return
    }

    let active = true
    setMapReady(false)

    const initMap = async () => {
      try {
        const ymaps3Api = await loadYandexMapsApi(apiKey)
        if (!active || !mapContainerRef.current) {
          return
        }

        ymapsRef.current = ymaps3Api

        const map = new ymaps3Api.YMap(mapContainerRef.current, {
          location: DEFAULT_LOCATION,
          behaviors: ['drag', 'scrollZoom', 'pinchZoom', 'dblClick'],
        })

        map
          .addChild(new ymaps3Api.YMapDefaultSchemeLayer({}))
          .addChild(new ymaps3Api.YMapDefaultFeaturesLayer({}))
          .addChild(new ymaps3Api.YMapFeatureDataSource({ id: MAP_SOURCE_ID }))
          .addChild(new ymaps3Api.YMapLayer({ source: MAP_SOURCE_ID, type: 'features', zIndex: 1800 }))

        mapRef.current = map
        setMapReady(true)
        setMapError('')
      } catch (error) {
        if (!active) {
          return
        }

        const errorMessage = error instanceof Error ? error.message : 'Не удалось загрузить Яндекс Карты'
        setMapError(errorMessage)
      }
    }

    initMap()

    return () => {
      active = false
      regionEntitiesRef.current = []

      if (mapRef.current) {
        mapRef.current.destroy()
        mapRef.current = null
      }
    }
  }, [apiKey])

  useEffect(() => {
    if (!mapReady || !mapRef.current || !ymapsRef.current) {
      return
    }

    for (const regionEntity of regionEntitiesRef.current) {
      regionEntity.entities.forEach((entity) => mapRef.current!.removeChild(entity))
    }
    regionEntitiesRef.current = []

    const features = geojson?.features || []

    features.forEach((feature, index) => {
      if (!feature.properties || !isMapGeometry(feature.geometry) || !mapRef.current || !ymapsRef.current) {
        return
      }

      const region = toRegionSelection(feature.properties, feature.geometry, index)
      const geometries = splitGeometryForMap(feature.geometry)
      const entities = geometries.map(
        (geometry, partIndex) =>
          new ymapsRef.current!.YMapFeature({
            id: `${region.key}-${partIndex}`,
            source: MAP_SOURCE_ID,
            geometry,
            disableRoundCoordinates: true,
            properties: feature.properties as Record<string, unknown>,
            style: getFeatureStyle(region, false, false, mapLevel, mapMetric, !!selectedRegion),
            onClick: () => {
              setSelectedRegion(region)
              setDrawerOpen(true)
              setInsight('')
            },
            onMouseEnter: () => {
              setHoveredRegion(region)
            },
            onMouseLeave: () => {
              setHoveredRegion((current) => (current?.key === region.key ? null : current))
            },
          })
      )

      entities.forEach((entity) => mapRef.current!.addChild(entity))
      regionEntitiesRef.current.push({ key: region.key, region, entities })
    })

    return () => {
      if (!mapRef.current) {
        return
      }

      for (const regionEntity of regionEntitiesRef.current) {
        regionEntity.entities.forEach((entity) => mapRef.current!.removeChild(entity))
      }
      regionEntitiesRef.current = []
    }
  }, [geojson, mapMetric, mapReady])

  useEffect(() => {
    if (!mapRef.current || !mapReady) {
      return
    }

    if (mapLevel === 'municipality' && selectedRegion?.focusLocation) {
      mapRef.current.setLocation({
        ...selectedRegion.focusLocation,
        duration: 500,
      })
      return
    }

    mapRef.current.setLocation({
      ...DEFAULT_LOCATION,
      duration: 500,
    })
  }, [mapLevel, mapReady, selectedRegion?.focusLocation, selectedRegion?.key])

  useEffect(() => {
    for (const regionEntity of regionEntitiesRef.current) {
      regionEntity.entities.forEach((entity) => {
        entity.update({
          style: getFeatureStyle(
            regionEntity.region,
            hoveredRegion?.key === regionEntity.key,
            selectedRegion?.key === regionEntity.key,
            mapLevel,
            mapMetric,
            !!selectedRegion
          ),
        })
      })
    }
  }, [hoveredRegion?.key, mapLevel, mapMetric, selectedRegion?.key])

  const handleAIInsight = async () => {
    if (!selectedRegion?.dbId) {
      message.warning('Сначала выберите регион на карте')
      return
    }

    setDrawerOpen(true)
    setInsightLoading(true)
    setInsight('')
    try {
      const result = await getAIInsight({ region_id: selectedRegion.dbId, year: displayYear })
      const nextInsight = result.insight?.trim()
      if (!nextInsight) {
        message.warning('AI-инсайт не вернул текста')
        return
      }
      setInsight(nextInsight)
    } catch {
      message.error('Не удалось получить AI-инсайт')
    } finally {
      setInsightLoading(false)
    }
  }

  if (!apiKey) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Для карты нужен ключ Яндекс Карт"
        description="Добавьте VITE_YANDEX_MAPS_API_KEY в окружение фронтенда. Для JS API v3 ключ должен быть создан с ограничением по HTTP Referer."
      />
    )
  }

  if (mapError) {
    return (
      <Alert
        type="error"
        showIcon
        message="Не удалось инициализировать Яндекс Карты"
        description={
          <>
            <div>{mapError}</div>
            <div style={{ marginTop: 8 }}>
              Проверьте `VITE_YANDEX_MAPS_API_KEY`, дождитесь активации ключа и убедитесь, что в ограничениях
              `HTTP Referer` разрешён `http://localhost:3000`.
            </div>
          </>
        }
      />
    )
  }

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <div
        ref={mapContainerRef}
        style={{
          height: '100%',
          width: '100%',
          borderRadius: 8,
          overflow: 'hidden',
          background: '#e5eef7',
        }}
      />

      {(isLoading || !mapReady) && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255,255,255,0.72)',
            zIndex: 1001,
          }}
        >
          <Spin size="large" tip="Загрузка карты..." />
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 1000,
          maxWidth: 420,
        }}
      >
        <div
          style={{
            background: 'rgba(255,255,255,0.96)',
            padding: '12px 14px',
            borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Уровень карты</div>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Метрика</div>
              <Segmented
                block
                options={[
                  { label: 'Плотность', value: 'density' },
                  { label: 'Динамика, %', value: 'change_percent' },
                ]}
                value={mapMetric}
                onChange={(value) => setMapMetric(value as MapMetric)}
              />
            </div>
            <div>
              {mapMetric === 'density' ? (
                <>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Год</div>
                  <Select
                    value={selectedYear}
                    style={{ width: '100%' }}
                    options={MAP_YEARS.map((year) => ({ value: year, label: `${year}` }))}
                    onChange={(value) => setSelectedYear(value)}
                  />
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Период</div>
                  <Space.Compact style={{ width: '100%' }}>
                    <Select
                      value={yearFrom}
                      style={{ width: '50%' }}
                      options={PERIOD_YEARS.filter((year) => year < yearTo).map((year) => ({
                        value: year,
                        label: `С ${year}`,
                      }))}
                      onChange={(value) => {
                        setYearFrom(value)
                        if (value >= yearTo) {
                          setYearTo(Math.min(2022, value + 1))
                        }
                      }}
                    />
                    <Select
                      value={yearTo}
                      style={{ width: '50%' }}
                      options={PERIOD_YEARS.filter((year) => year > yearFrom).map((year) => ({
                        value: year,
                        label: `По ${year}`,
                      }))}
                      onChange={(value) => {
                        setYearTo(value)
                        if (value <= yearFrom) {
                          setYearFrom(Math.max(2010, value - 1))
                        }
                      }}
                    />
                  </Space.Compact>
                </>
              )}
            </div>
            <Segmented
              block
              options={[
                { label: 'Регионы', value: 'region' },
                { label: 'Муниципалитеты', value: 'municipality' },
              ]}
              value={mapLevel}
              onChange={(value) => setMapLevel(value as MapLevel)}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {mapLevel === 'region'
                ? mapMetric === 'density'
                  ? 'Хлороплет по плотности населения регионов.'
                  : `Хлороплет изменения населения за период ${yearFrom}–${yearTo}.`
                : 'Выберите регион на карте: карта перейдёт в drill-down, а справа откроется список муниципалитетов.'}
            </Typography.Text>
            <Space wrap>
              <Button
                type="primary"
                icon={<BulbOutlined />}
                onClick={handleAIInsight}
                loading={insightLoading}
                disabled={!selectedRegion?.dbId}
              >
                AI Инсайт
              </Button>
              {selectedRegion && mapLevel === 'region' && (
                <Button onClick={() => setMapLevel('municipality')}>
                  Муниципалитеты региона
                </Button>
              )}
              {selectedRegion && (
                <Button
                  onClick={() => {
                    setSelectedRegion(null)
                    setHoveredRegion(null)
                    setDrawerOpen(false)
                    setInsight('')
                  }}
                >
                  Сбросить выбор
                </Button>
              )}
            </Space>
          </Space>
        </div>
      </div>

      {hoveredRegion && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            background: 'rgba(255,255,255,0.96)',
            padding: '10px 12px',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            zIndex: 1000,
            minWidth: 240,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{hoveredRegion.name}</div>
          {hoveredRegion.hasCoverage ? (
            <>
              <div style={{ color: '#4a5568', fontSize: 12 }}>
                {mapMetric === 'density'
                  ? `Плотность (${selectedYear}): ${formatDensity(hoveredRegion.density)}`
                  : hoveredRegion.changePercent != null
                    ? `Динамика ${hoveredRegion.yearFrom ?? yearFrom}–${hoveredRegion.yearTo ?? yearTo}: ${formatChangePercent(hoveredRegion.changePercent)}`
                    : 'Для этого периода нет данных о динамике населения'}
              </div>
              <div style={{ color: '#4a5568', fontSize: 12, marginTop: 4 }}>
                {`Население (${displayYear}): ${formatPopulation(hoveredRegion.population)}`}
              </div>
              {mapMetric === 'change_percent' && (
                <div style={{ color: '#718096', fontSize: 12, marginTop: 4 }}>
                  {`Плотность (${displayYear}): ${formatDensity(hoveredRegion.density)}`}
                </div>
              )}
              {mapMetric === 'change_percent' && hoveredRegion.populationStart != null && hoveredRegion.populationEnd != null && (
                <div style={{ color: '#718096', fontSize: 12, marginTop: 4 }}>
                  {formatPopulation(hoveredRegion.populationStart)} → {formatPopulation(hoveredRegion.populationEnd)}
                </div>
              )}
            </>
          ) : (
            <div style={{ color: '#4a5568', fontSize: 12 }}>
              Для этого полигона нет демографических данных в текущем наборе
            </div>
          )}
        </div>
      )}

      {uncoveredRegions.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: hoveredRegion ? 94 : 10,
            left: 10,
            zIndex: 1000,
            maxWidth: 360,
          }}
        >
          <Alert
            type="warning"
            showIcon
            message="Не все полигоны связаны с данными"
            description={`Без покрытия: ${uncoveredRegions.map((feature) => feature.properties?.name || feature.properties?.NAME_1).join(', ')}`}
          />
        </div>
      )}

      {mapLevel === 'municipality' && !selectedRegion && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(255,255,255,0.96)',
            padding: '16px 18px',
            borderRadius: 12,
            boxShadow: '0 10px 30px rgba(0,0,0,0.14)',
            zIndex: 1000,
            maxWidth: 360,
            textAlign: 'center',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Выберите регион</div>
          <div style={{ color: '#4a5568', fontSize: 13 }}>
            Клик по региону откроет список его муниципалитетов и переведёт карту в детальный обзор.
          </div>
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          bottom: 30,
          left: 10,
          background: 'white',
          padding: '12px 16px',
          borderRadius: 8,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          zIndex: 1000,
          fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          {mapMetric === 'density' ? `Плотность населения, ${selectedYear}` : `Изменение населения, ${yearFrom}–${yearTo}`}
        </div>
        {(mapMetric === 'density'
          ? [
              { color: '#4a0d18', label: '≥ 500 чел./км²' },
              { color: '#7f1d1d', label: '100 — 500 чел./км²' },
              { color: '#b91c1c', label: '50 — 100 чел./км²' },
              { color: '#dc2626', label: '20 — 50 чел./км²' },
              { color: '#ef4444', label: '10 — 20 чел./км²' },
              { color: '#f87171', label: '5 — 10 чел./км²' },
              { color: '#fca5a5', label: '1 — 5 чел./км²' },
              { color: '#fee2e2', label: '< 1 чел./км²' },
              { color: '#d9d9d9', label: 'Нет покрытия данных' },
            ]
          : [
              { color: '#22543d', label: '≥ +10%' },
              { color: '#276749', label: '+5% — +10%' },
              { color: '#38a169', label: '+1% — +5%' },
              { color: '#68d391', label: '0% — +1%' },
              { color: '#fc8181', label: '0% — -1%' },
              { color: '#e53e3e', label: '-1% — -5%' },
              { color: '#c53030', label: '-5% — -10%' },
              { color: '#9b2c2c', label: '< -10%' },
              { color: '#d9d9d9', label: 'Нет данных за период' },
            ]
        ).map((item) => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <div style={{ width: 16, height: 12, background: item.color, borderRadius: 2 }} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>

      <Drawer
        title={selectedRegion ? (mapLevel === 'municipality' ? `${selectedRegion.name}: муниципалитеты` : selectedRegion.name) : 'Регион'}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={420}
      >
        {selectedRegion && (
          <>
            <Row gutter={[16, 16]}>
              <Col span={12}>
                <Statistic
                  title={`Население, ${displayYear}`}
                  value={selectedRegion.hasCoverage ? formatPopulation(selectedRegion.population) : 'Нет данных'}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title={`Плотность, ${displayYear}`}
                  value={selectedRegion.hasCoverage ? formatDensity(selectedRegion.density) : 'Нет данных'}
                />
              </Col>
              {selectedRegion.changePercent != null && (
                <Col span={24}>
                  <Statistic
                    title={`Динамика, ${selectedRegion.yearFrom ?? yearFrom}–${selectedRegion.yearTo ?? yearTo}`}
                    value={formatChangePercent(selectedRegion.changePercent)}
                    valueStyle={{ color: getGrowthColor(selectedRegion.changePercent) }}
                  />
                </Col>
              )}
              {selectedRegion.areaSqKm != null && (
                <Col span={24}>
                  <Typography.Text type="secondary">
                    {`Площадь покрытия набора данных: ${formatArea(selectedRegion.areaSqKm)}`}
                  </Typography.Text>
                </Col>
              )}
              {selectedRegion.changePercent != null && selectedRegion.populationStart != null && selectedRegion.populationEnd != null && (
                <Col span={24}>
                  <Typography.Text type="secondary">
                    {formatPopulation(selectedRegion.populationStart)} → {formatPopulation(selectedRegion.populationEnd)}
                  </Typography.Text>
                </Col>
              )}
            </Row>

            {!selectedRegion.hasCoverage && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 16 }}
                message="Для этого региона в текущем наборе нет привязанных демографических данных"
              />
            )}

            {(insightLoading || insight) && (
              <div
                style={{
                  marginTop: 24,
                  padding: 16,
                  background: '#f0f7ff',
                  borderRadius: 8,
                  borderLeft: '4px solid #2b6cb0',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 8, color: '#2b6cb0' }}>
                  AI Инсайт
                </div>
                {insightLoading ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
                    <Spin size="small" />
                  </div>
                ) : (
                  <div style={{ lineHeight: 1.6 }}>{insight}</div>
                )}
              </div>
            )}

            {mapLevel === 'municipality' && (
              <div style={{ marginTop: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <Typography.Text strong>Муниципалитеты региона, {displayYear}</Typography.Text>
                  <Tag color="blue">{municipalities.length}</Tag>
                </div>

                {selectedRegion.dbId ? (
                  municipalitiesLoading ? (
                    <div style={{ padding: '24px 0', display: 'flex', justifyContent: 'center' }}>
                      <Spin />
                    </div>
                  ) : (
                    <List
                      size="small"
                      bordered
                      dataSource={municipalities}
                      locale={{ emptyText: 'Муниципалитеты не найдены' }}
                      renderItem={(municipality) => (
                        <List.Item>
                          <div style={{ width: '100%' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                              <Typography.Text strong>{municipality.name}</Typography.Text>
                              <div style={{ textAlign: 'right' }}>
                                <Typography.Text>
                                  {municipality.population != null ? formatPopulation(municipality.population) : '—'}
                                </Typography.Text>
                                <div style={{ marginTop: 4, color: '#718096', fontSize: 12 }}>
                                  {municipality.population != null && municipality.area_sq_km
                                    ? `Плотность: ${formatDensity(municipality.population / municipality.area_sq_km)}`
                                    : 'Плотность: —'}
                                </div>
                              </div>
                            </div>
                            <div style={{ marginTop: 4, color: '#718096', fontSize: 12 }}>
                              {formatMunicipalityType(municipality.municipality_type)}
                              {municipality.oktmo_code ? ` · ОКТМО ${municipality.oktmo_code}` : ''}
                            </div>
                          </div>
                        </List.Item>
                      )}
                    />
                  )
                ) : (
                  <Alert
                    type="warning"
                    showIcon
                    message="Список муниципалитетов недоступен"
                    description="Этот полигон не связан с регионом из демографического набора данных."
                  />
                )}
              </div>
            )}
          </>
        )}
      </Drawer>
    </div>
  )
}
