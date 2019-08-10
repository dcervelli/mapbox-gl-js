// @flow

import { Event, ErrorEvent, Evented } from "../util/evented";

import { extend } from "../util/util";
import EXTENT from "../data/extent";
import { ResourceType } from "../util/ajax";
import browser from "../util/browser";

import type { Source } from "./source";
import type Map from "../ui/map";
import type Dispatcher from "../util/dispatcher";
import type Tile from "./tile";
import type { Callback } from "../types/callback";
import type { GeoJSON, GeoJSONFeature } from "@mapbox/geojson-types";
import type { GeobufferSourceSpecification } from "../style-spec/types";

import { geoJsonToGeobuffer } from "@acme/geobuffer";
import type { GeobufferFeatureCollection } from "@acme/geobuffer";

class GeobufferSource extends Evented implements Source {
    type: "geobuffer";
    id: string;
    minzoom: number;
    maxzoom: number;
    tileSize: number;
    attribution: string;

    isTileClipped: boolean;
    reparseOverscaled: boolean;
    // _data: GeoJSON | string;

    _data: GeobufferFeatureCollection;
    _options: any;
    workerOptions: any;
    dispatcher: Dispatcher;
    map: Map;
    workerID: number;
    _loaded: boolean;
    _collectResourceTiming: boolean;
    _resourceTiming: Array<PerformanceResourceTiming>;
    _removed: boolean;

    constructor(
        id: string,
        options: GeobufferSourceSpecification & { workerOptions?: any, collectResourceTiming: boolean },
        dispatcher: Dispatcher,
        eventedParent: Evented
    ) {
        super();

        this.id = id;

        // `type` is a property rather than a constant to make it easy for 3rd
        // parties to use GeoJSONSource to build their own source types.
        this.type = "geobuffer";

        this.minzoom = 0;
        this.maxzoom = 18;
        this.tileSize = 512;
        this.isTileClipped = true;
        this.reparseOverscaled = true;
        this._removed = false;

        this.dispatcher = dispatcher;
        this.setEventedParent(eventedParent);

        this._data = options.data;
        this._options = extend({}, options);

        this._collectResourceTiming = options.collectResourceTiming;
        this._resourceTiming = [];

        if (options.maxzoom !== undefined) this.maxzoom = options.maxzoom;
        if (options.type) this.type = options.type;
        if (options.attribution) this.attribution = options.attribution;

        const scale = EXTENT / this.tileSize;

        // sent to the worker, along with `url: ...` or `data: literal geojson`,
        // so that it can load/parse/index the geojson data
        // extending with `options.workerOptions` helps to make it easy for
        // third-party sources to hack/reuse GeoJSONSource.
        this.workerOptions = extend(
            {
                source: this.id,
                geojsonVtOptions: {
                    buffer: (options.buffer !== undefined ? options.buffer : 128) * scale,
                    tolerance: (options.tolerance !== undefined ? options.tolerance : 0.375) * scale,
                    extent: EXTENT,
                    maxZoom: this.maxzoom,
                    lineMetrics: options.lineMetrics || false,
                    generateId: options.generateId || false,
                },
            },
            options.workerOptions
        );
    }

    load() {
        this.fire(new Event('dataloading', {dataType: 'source'}));
        this._updateWorkerData((err) => {
            if (err) {
                this.fire(new ErrorEvent(err));
                return;
            }

            const data: Object = { dataType: 'source', sourceDataType: 'metadata' };
            if (this._collectResourceTiming && this._resourceTiming && (this._resourceTiming.length > 0)) {
                data.resourceTiming = this._resourceTiming;
                this._resourceTiming = [];
            }

            // although GeoJSON sources contain no metadata, we fire this event to let the SourceCache
            // know its ok to start requesting tiles.
            this.fire(new Event('data', data));
        });
    }

    _updateWorkerData(callback: Callback<void>) {
        const options = extend({}, this.workerOptions);
        options.data = this._data;

        // target {this.type}.loadData rather than literally geojson.loadData,
        // so that other geojson-like source types can easily reuse this
        // implementation
        this.workerID = this.dispatcher.send(`${this.type}.loadData`, options, (err, result) => {
            if (this._removed || (result && result.abandoned)) {
                return;
            }

            this._loaded = true;

            if (result && result.resourceTiming && result.resourceTiming[this.id])
                this._resourceTiming = result.resourceTiming[this.id].slice(0);
            // Any `loadData` calls that piled up while we were processing
            // this one will get coalesced into a single call when this
            // 'coalesce' message is processed.
            // We would self-send from the worker if we had access to its
            // message queue. Waiting instead for the 'coalesce' to round-trip
            // through the foreground just means we're throttling the worker
            // to run at a little less than full-throttle.
            this.dispatcher.send(`${this.type}.coalesce`, { source: options.source }, null, this.workerID);
            callback(err);

        }, this.workerID);
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
    }

    loadTile(tile: Tile, callback: Callback<void>) {
        const message = tile.workerID === undefined ? 'loadTile' : 'reloadTile';
        const params = {
            type: this.type,
            uid: tile.uid,
            tileID: tile.tileID,
            zoom: tile.tileID.overscaledZ,
            maxZoom: this.maxzoom,
            tileSize: this.tileSize,
            source: this.id,
            pixelRatio: browser.devicePixelRatio,
            showCollisionBoxes: this.map.showCollisionBoxes
        };

        tile.workerID = this.dispatcher.send(message, params, (err, data) => {
            tile.unloadVectorData();

            if (tile.aborted) {
                return callback(null);
            }

            if (err) {
                return callback(err);
            }

            tile.loadVectorData(data, this.map.painter, message === 'reloadTile');

            return callback(null);
        }, this.workerID);
    }

    abortTile(tile: Tile) {
        tile.aborted = true;
    }

    unloadTile(tile: Tile) {
        tile.unloadVectorData();
        this.dispatcher.send('removeTile', { uid: tile.uid, type: this.type, source: this.id }, null, tile.workerID);
    }

    onRemove() {
        this._removed = true;
        this.dispatcher.send('removeSource', { type: this.type, source: this.id }, null, this.workerID);
    }

    serialize() {
        const buffer = geoJsonToGeobuffer({
            type: "Point",
            coordinates: [-118, 36],
        });
        return {};
    }

    hasTransition() {
        return false;
    }
}

export default GeobufferSource;
