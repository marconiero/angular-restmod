'use strict';

var $restmodMinErr = angular.noop; //minErr('$restmod');

// The object property synchronization mask.
var SyncMask = {
  NONE: 0x00,
  ALL: 0xFFFF,

  DECODE_CREATE: 0x0001,
  DECODE_UPDATE: 0x0002,
  DECODE_USER: 0x0004,
  DECODE_SAVE: 0x0003,

  ENCODE_CREATE: 0x0100,
  ENCODE_UPDATE: 0x0200,
  ENCODE_USER: 0x0400,
  ENCODE_SAVE: 0x0300,

  // Compound masks
  DECODE: 0x00FF,
  ENCODE: 0xFF00,
  CREATE: 0x0101,
  UPDATE: 0x0202,
  USER: 0x0404,
  SAVE: 0x0303
};

// Cache some angular stuff
var bind = angular.bind,
    forEach = angular.forEach,
    extend = angular.extend,
    isObject = angular.isObject,
    isArray = angular.isArray,
    isFunction = angular.isFunction,
    arraySlice = Array.prototype.slice;

angular.module('plRestmod').provider('$restmod', function() {

  /* Module Globals */
  var BASE_CHAIN = [];

  return {
    /**
     * Adds mixins to the base model chain.
     *
     * Non abstract models should NOT be added to this chain.
     *
     * Base model chain is by default empty, all mixins added to the chain are
     * prepended to every generated model.
     *
     * $provider.pushModelBase('ChangeModel', 'LazyRelations', 'ThrottledModel')
     *
     */
    pushModelBase: function(/* mixins */) {
      Array.prototype.push.apply(BASE_CHAIN, arguments);
      return this;
    },
    /**
     * The factory function, returns a new model builder factory.
     *
     * The model builder factory can be used to generate new model builder instances
     * given an url and a series of metadata objects, once generated, the model builder
     * can be used generate a new model.
     *
     * The `_url` parameter also accepts an url builder implementation.
     */
    $get: ['$http', '$q', '$injector', '$parse', '$filter', function($http, $q, $injector, $parse, $filter) {

      function loadMeta(_meta, _builder) {
        if(_meta.$meta) {
          loadMeta(_meta.$meta, _builder);
        } else if(typeof _meta === 'string') {
          loadMeta($injector.get(_meta), _builder);
        } else if(isArray(_meta)) {
          var i=0, meta;
          while((meta = _meta[i++])) {
            loadMeta(meta, _builder);
          }
        } else if(typeof _meta === 'function') {
          // TODO: maybe invoke should only be called for BASE_CHAIN functions
          $injector.invoke(_meta, _builder, { $builder: _builder });
        } else _builder.describe(_meta);
      }

      var restmod = function(_urlParams/* , _meta */) {

        var masks = {
            $partial: SyncMask.ALL,
            $context: SyncMask.ALL,
            $promise: SyncMask.ALL,
            $pending: SyncMask.ALL,
            $error: SyncMask.ALL
            },
            defaults = [],
            decoders = {},
            encoders = {},
            callbacks = {},
            urlBuilder, nameEncoder, nameDecoder;

        // runs all callbacks associated with a given hook.
        function callback(_hook, _ctx /*, args */) {
          var cbs = callbacks[_hook];
          if(cbs) {
            var i = 0, args = arraySlice.call(arguments, 2), cb;
            while((cb = cbs[i++])) {
              // execute callback
              cb.apply(_ctx, args);
            }
          }
        }

        // common http behavior, used both in collections and model instances.
        function send(_target, _config, _success, _error) {

          // IDEA: comm queuing, never allow two simultaneous requests.
          // if(this.$pending) {
          //  this.$promise.then(function() {
          //    this.$send(_config, _success, _error);
          //    });
          // }

          _target.$pending = true;
          _target.$error = false;
          _target.$promise = $http(_config).then(function(_response) {

            // IDEA: a response interceptor could add additional error states based on returned data,
            // this could allow for additional error state behaviours (for example, an interceptor
            // could watch for rails validation errors and store them in the model, then return false
            // to trigger a promise queue error).

            _target.$pending = false;

            if(_success) _success.call(_target, _response);

            return _target;

          }, function(_response) {

            _target.$pending = false;
            _target.$error = true;

            if(_error) _error.call(_target, _response);

            return $q.reject(_target);
          });
        }

        /**
         * The Model Type definition
         *
         * TODO: Describe model type
         */

        /**
         * Model constructor
         *
         * @param {object} _init Initial model data [optional]
         * @param {string} _url Model url override or partial url if context is given [optional]
         * @param {Model|Model.collection} _context Model context [internal]
         */
        var Model = function(_init, _url, _context) {

          this.$pending = false;
          this.$partial = _url;
          this.$context = _context;

          var tmp;

          // apply defaults
          for(var i = 0; (tmp = defaults[i]); i++) {
            this[tmp[0]] = (typeof tmp[1] === 'function') ? tmp[1].apply(this) : tmp[1];
          }

          if(_init) {
            // copy initial values (if given)
            for(tmp in _init) {
              if (_init.hasOwnProperty(tmp)) {
                this[tmp] = _init[tmp];
              }
            }
          }
        };

        extend(Model, {
          /**
           * The Model mixin chain.
           * @type {array}
           */
          $meta: arraySlice.call(arguments, 1),
          /**
           * Returns the url this collection is bound to.
           *
           * @param {object} _opt Options to be passed to the url builder.
           * @return {string} bound url.
           */
          $url: function(_opt) {
            return urlBuilder.collectionUrl(this, _opt);
          },
          $build: function(_key) {
            var init, keyName;
            if(!isObject(_key)) {
              init = {};
              keyName = urlBuilder.inferKey(this);
              if(!keyName) throw $restmodMinErr('notsup', 'Cannot infer build key, use explicit mode');
              init[keyName] = _key;
            } else init = _key;

            var obj = new Model(init, null, this);
            if(this.$isCollection) this.push(obj); // on collection, push new object
            return obj;
          },
          $buildRaw: function(_raw) {
            return this.$build(null).$decode(_raw);
          },
          $create: function(_attr, _success, _error) {
            return this.$build(_attr).$save(_success, _error);
          },
          $find: function(_key, _success, _error) {
            var init, keyName;
            if(!isObject(_key)) {
              init = {};
              keyName = urlBuilder.inferKey(this);
              if(!keyName) throw $restmodMinErr('notsup', 'Cannot infer find key, use explicit mode');
              init[keyName] = _key;
            } else init = _key;

            // dont use $build, find does not push into current collection.
            return (new Model(init, null, this)).$fetch(_success, _error);
          },
          /**
           * Builds a new collection
           *
           * @param  {[type]} _params  [description]
           * @param  {[type]} _url     [description]
           * @param  {[type]} _context [description]
           * @return {[type]}          [description]
           */
          $collection: function(_params, _url, _context) {

            _params = this.$params ? extend({}, this.$params, _params) : _params;

            var col = [];

            // Since Array cannot be extended, use method injection
            // TODO: try to find a faster alternative, use for loop insted for example.
            for(var key in this) {
              if(this.hasOwnProperty(key)) col[key] = this[key];
            }

            col.$partial = _url || this.$partial;
            col.$context = _context || this.$context;
            col.$isCollection = true;
            col.$params = _params;
            col.$pending = false;
            col.$resolved = false;

            return col;
          },
          $search: function(_params, _success, _error) {
            return this.$collection(_params).$fetch(_success, _error);
          },
          /**
           * Promise chaining method, keeps the collection instance as the chain context.
           *
           * Usage: col.$fetch().$then(function() { });
           *
           * @param {function} _success success callback
           * @param {function} _error error callback
           * @return {Model} self
           */
          $then: function(_success, _error) {
            if(this.$isCollection) {
              this.$promise = this.$promise.then(_success, _error);
            }
            return this;
          },
          /**
           * Resets the collection's contents, marks collection as not $resolved
           *
           * @return {Model} self
           */
          $reset: function() {
            if(this.$isCollection) {
              this.$resolved = false;
              this.length = 0;
            }
            return this;
          },
          /**
           * Feeds raw collection data into the collection, marks collection as $resolved
           *
           * @param {array} _raw Data to add
           * @return {Model} self
           */
          $feed: function(_raw) {
            if(this.$isCollection) {
              forEach(_raw, this.$buildRaw, this);
              this.$resolved = true;
            }
            return this;
          },
          /**
           * Begin a server request to populate collection.
           *
           * TODO: support POST data queries (complex queries scenarios)
           *
           * @param {object} _params Additional request parameters, this parameters are not stored in collection.
           * @return {[type]} [description]
           */
          $fetch: function(_params) {

            if(this.$isCollection)
            {
              var params = _params ? extend({}, this.$params || {}, _params) : this.$params;

              // TODO: check that collection is bound.
              send(this, { method: 'GET', url: this.$url(), params: params }, function(_response) {

                var data = _response.data;
                if(!data || !isArray(data)) {
                  throw $restmodMinErr('badcfg', 'Error in resource {0} configuration. Expected response to be array');
                }

                // reset and feed retrieved data.
                this.$reset().$feed(data);

                // execute callback
                callback('after_collection_fetch', this, _response);
              });
            }

            return this;
          }

          // IDEA: $push, $remove, etc
        });

        /**
         *
         */

        Model.prototype = {
          /**
           * Returns the url this object is bound to.
           *
           * @param {object} _opt Options to be passed to the url builder.
           * @return {string} bound url.
           */
          $url: function(_opt) {
            return urlBuilder.resourceUrl(this, _opt);
          },
          /**
           * Allows calling custom hooks, usefull when implementing custom actions.
           *
           * Passes through every additional arguments to registered hooks.
           * Hooks are registered using the ModelBuilder.on method.
           *
           * @param {string} _hook hook name
           * @return {Model} self
           */
          $callback: function(_hook /*, args */) {
            callback(this, _hook, arraySlice.call(arguments, 1));
            return this;
          },
          /**
           * Low level communication method, wraps the $http api.
           *
           * @param {object} _options $http options
           * @param {function} _success sucess callback (sync)
           * @param {function} _error error callback (sync)
           * @return {Model} self
           */
          $send: function(_options, _success, _error) {
            send(this, _options, _success, _error);
            return this;
          },
          /**
           * Promise chaining method, keeps the model instance as the chain context.
           *
           * Usage: col.$fetch().$then(function() { });
           *
           * @param {function} _success success callback
           * @param {function} _error error callback
           * @return {Model} self
           */
          $then: function(_success, _error) {
            this.$promise = this.$promise.then(_success, _error);
            return this;
          },
          /**
           * Feed raw data to this instance.
           *
           * @param {object} _raw Raw data to be fed
           * @param {string} _action Action that originated the fetch
           * @return {Model} this
           */
          $decode: function(_raw, _mask) {
            if(!_mask) _mask = SyncMask.DECODE_USER;

            // TODO: does undefined & 1 evaluates to 0 in every browser?
            // TODO: var original = {}; // enable change queries
            var key, decodedName, decoder, value, original = {};
            for(key in _raw) {
              if(_raw.hasOwnProperty(key) && !((masks[key] || 0) & _mask)) {
                decodedName = nameDecoder ? nameDecoder(key) : key;
                decoder = decoders[decodedName];
                value = decoder ? decoder.call(this, _raw[key]) : _raw[key];

                if(value !== undefined) {
                  original[decodedName] = this[decodedName] = value;
                }
              }
            }

            callback('after_feed', this, original, _raw);
            return this;
          },
          /**
           * Generate data to be sent to the server when creating/updating the resource.
           *
           * @param {string} _action Action that originated the render
           * @return {Model} this
           */
          $encode: function(_mask) {
            if(!_mask) _mask = SyncMask.ENCODE_USER;

            var key, encodedName, encoder, raw = {};
            for(key in this) {
              if(this.hasOwnProperty(key) && !((masks[key] || 0) & _mask)) {
                encodedName = nameEncoder ? nameEncoder(key) : key;
                encoder = encoders[key];
                raw[encodedName] = encoder ? encoder.call(this, this[key]) : this[key];
              }
            }

            callback('before_render', this, raw);

            return raw;
          },
          /**
           * Begin a server request for updated resource data.
           *
           * The request's promise is provided as the $promise property.
           *
           * @return {Model} this
           */
          $fetch: function() {
            // verify that instance has a bound url
            if(!this.$url()) throw $restmodMinErr('notsup', 'Cannot fetch an unbound resource');
            return this.$send({ method: 'GET', url: this.$url(), feed: true }, function(_response) {
              var data = _response.data;
              if (!data || isArray(data)) {
                throw $restmodMinErr('badresp', 'Expected object while feeding resource');
              }
              this.$decode(data);
            });
          },
          /**
           * Begin a server request to create/update resource.
           *
           * The request's promise is provided as the $promise property.
           *
           * @return {Model} this
           */
          $save: function() {
            var url;

            if(this.$url()) {
              // If bound, update

              url = urlBuilder.updateUrl(this);
              if(!url) throw $restmodMinErr('notsup', 'Update is not supported by this resource');

              callback('before_update', this);
              callback('before_save', this);
              return this.$send({ method: 'PUT', url: url, data: this.$encode(SyncMask.ENCODE_CREATE) }, function(_response) {

                // IDEA: maybe this should be a method call (like $feedCreate), this would allow
                // a user to override the feed logic for each action... On the other hand, allowing
                // this breaks the extend-using-hooks convention.

                var data = _response.data;
                if (data && !isArray(data)) this.$decode(data, SyncMask.DECODE_UPDATE);

                callback('after_update', this);
                callback('after_save', this);
              });
            } else {
              // If not bound create.

              url = urlBuilder.createUrl(this);
              if(!url) throw $restmodMinErr('notsup', 'Create is not supported by this resource');

              callback('before_save', this);
              callback('before_create', this);
              return this.$send({ method: 'POST', url: url, data: this.$encode(SyncMask.ENCODE_UPDATE) }, function(_response) {

                var data = _response.data;
                if (data && !isArray(data)) this.$decode(data, SyncMask.DECODE_CREATE);

                callback('after_create', this);
                callback('after_save', this);
              });
            }
          },
          /**
           * Begin a server request to destroy the resource.
           *
           * The request's promise is provided as the $promise property.
           *
           * @return {Model} this
           */
          $destroy: function() {
            var url = urlBuilder.destroyUrl(this);
            if(!url) throw $restmodMinErr('notsup', 'Destroy is not supported by this resource');

            callback('before_destroy', this);
            return this.$send({ method: 'DELETE', url: url }, function() {
              callback('after_destroy', this);
            });
          }
        };

        /**
         * Model customization phase:
         * * Generate the model builder DSL
         * * Process metadata from base chain
         * * Process metadata from arguments
         */

        // Available mappings.
        var mappings = {
          init: ['attrDefault'],
          ignore: ['attrIgnored'],
          decode: ['attrDecoder', 'param', 'chain'],
          encode: ['attrEncoder', 'param', 'chain'],
          type: ['attrSerializer'],
          hasMany: ['hasMany', 'alias'],
          hasOne: ['hasOne', 'alias']
        }, urlBuilderFactory;

        var Builder = {
          setHttpOptions: function(_options) {
            // TODO.
          },
          /**
           * Change the default url builder.
           *
           * The provided factory will be called to provide an url builder
           * for  implement a `get` method that receives the resource baseUrl
           * and returns an url builder.
           *
           * TODO: describe url builder interface
           *
           * @param {function} _factory Url builder factory function.
           */
          setUrlBuilderFactory: function(_factory) {
            urlBuilderFactory = _factory;
            return this;
          },
          /**
           * Changes the way restmod renames attributes every time a server resource is decoded.
           *
           * This is intended to be used as a way of keeping property naming style consistent accross
           * languajes. By default, property naming in js should use camelcase and property naming
           * in JSON api should use snake case with underscores.
           *
           * If `false` is given, then renaming is disabled
           *
           * @param {function|false} _value
           * @return {object} self
           */
          setNameDecoder: function(_decoder) {
            nameDecoder = _decoder;
            return this;
          },
          /**
           * Changes the way restmod renames attributes every time a local resource is encoded to be sent.
           *
           * This is intended to be used as a way of keeping property naming style consistent accross
           * languajes. By default, property naming in js should use camelcase and property naming
           * in JSON api should use snake case with underscores.
           *
           * If `false` is given, then renaming is disabled
           *
           * @param {function|false} _value
           * @return {object} self
           */
          setNameEncoder: function(_encoder) {
            nameEncoder = _encoder;
            return this;
          },
          /**
           * Disables renaming alltogether
           *
           * @return {object} self
           */
          disableRenaming: function() {
            return this
              .setNameDecoder(false)
              .setNameEncoder(false);
          },
          /**
           * Extends the builder DSL
           *
           * Adds a function to de builder and alternatively maps the function to an
           * attribute definition keyword that can be later used when calling
           * `define` or `attribute`.
           *
           * Mapping works as following:
           *
           *    // Given the following call
           *    builder.extend('testAttr', function(_attr, _test, _param1, param2) {
           *      // wharever..
           *    }, ['test', 'testP1', 'testP2']);
           *
           *    // A call to
           *    builder.attribute('chapter', { test: 'hello', testP1: 'world' });
           *
           *    // Its equivalent to
           *    builder.testAttr('chapter', 'hello', 'world');
           *
           * The method can also be passed an object with various methods to be added.
           *
           * @param {string|object} _name function name or object to merge
           * @param {function} _fun function
           * @param {array} _mapping function mapping definition
           * @return {object} self
           */
          extend: function(_name, _fun, _mapping) {
            if(typeof _name === 'string') {
              this[_name] = Utils.override(this[name], _fun);
              if(_mapping) {
                mappings[_mapping[0]] = _mapping;
                _mapping[0] = _name;
              }
            } else Utils.extendOverriden(this, _name);
            return this;
          },
          /**
           * Parses a description object, calls the proper builder method depending
           * on each property description type.
           *
           * @param {object} _description The description object
           * @return {object} self
           */
          describe: function(_description) {
            forEach(_description, function(_desc, _attr) {
              if(isObject(_desc)) this.attribute(_attr, _desc);
              else if(isFunction(_desc)) this.define(_attr, _desc);
              else this.attrDefault(_attr, _desc);
            }, this);
            return this;
          },
          /**
           * Sets an attribute properties.
           *
           * This method uses the attribute modifiers mapping to call proper
           * modifiers on the argument.
           *
           * For example, using the following description on the createdAt attribute
           *
           *    { decode: 'date', param; 'YY-mm-dd' }
           *
           * Is the same as calling
           *
           *    builder.attrDecoder('createdAt', 'date', 'YY-mm-dd')
           *
           * @param {string} _name Attribute name
           * @param {object} _description Description object
           * @return {object} self
           */
          attribute: function(_name, _description) {
            var key, map, args, i;
            for(key in _description) {
              if(_description.hasOwnProperty(key)) {
                map = mappings[key];
                if(map) {
                  args = [_name, _description[key]];
                  for(i = 1; i < map.length; i++) {
                    args.push(_description[map[i]]);
                  }
                  args.push(_description);
                  this[map[0]].apply(this, args);
                }
              }
            }
            return this;
          },

          /// Attribute behavior

          /**
           * Sets the default value for an attribute.
           *
           * Defaults values are set only on object construction phase.
           *
           * if `_init` is a function, then its evaluated every time the
           * default value is required.
           *
           * @param {string} _attr Attribute name
           * @param {mixed} _init Defaulf value / iniline function
           * @return {object} self
           */
          attrDefault: function(_attr, _init) {
            // IDEA: maybe fixed defaults could be added to Model prototype...
            defaults.push([_attr, _init]);
            return this;
          },
          /**
           * Ignores/un-ignores an attribute.
           *
           * This method changes the attribute masmask
           *
           * @param {string} _attr Attribute name
           * @param {boolean|integer} _mask Ignore mask.
           * @param {boolean} _reset If set to true, old mask is reset.
           * @return {[type]} [description]
           */
          attrIgnored: function(_attr, _mask, _reset) {

            if(_mask === true) {
              masks[_attr] = SyncMask.ALL;
            } else if(_mask === false) {
              delete masks[_attr];
            } else if(_reset) {
              masks[_attr] = _mask;
            } else {
              masks[_attr] |= _mask;
            }

            return this;
          },
          /**
           * Assigns a serializer to a given attribute.
           *
           * A _serializer is:
           * * an object that defines both a `decode` and a `encode` method
           * * a function that when called returns an object that matches the above description.
           * * a string that represents an injectable that matches any of the above descriptions.
           *
           * @param {string} _name Attribute name
           * @param {string|object|function} _serializer The serializer
           * @return {object} self
           */
          attrSerializer: function(_name, _serializer, _opt) {
            if(typeof _serializer === 'string') {
              _serializer = $injector.get(Utils.camelcase(_serializer) + 'Serializer')
            }

            // TODO: if(!_serializer) throw $setupError
            if(isFunction(_serializer)) _serializer = _serializer(_opt);
            if(_serializer.decode) this.attrDecoder(_name, bind(_serializer, _serializer.decode));
            if(_serializer.encode) this.attrEncoder(_name, bind(_serializer, _serializer.encode));
            return this;
          },
          /**
           * Assigns a decoding function/filter to a given attribute.
           *
           * @param {string} _name Attribute name
           * @param {string|function} _filter filter or function to register
           * @param {mixed} _filterParam Misc filter parameter
           * @param {boolean} _chain If true, filter is chained to the current attribute filter.
           * @return {object} self
           */
          attrDecoder: function(_name, _filter, _filterParam, _chain) {
            if(typeof _filter === 'string') {
              var filter = $filter(_filter);
              // TODO: if(!_filter) throw $setupError
              _filter = function(_value) { return filter(_value, _filterParam); };
            }

            decoders[_name] = _chain ? chain(decoders[_name], _filter) : _filter;
            return this;
          },
          /**
           * Assigns a encoding function/filter to a given attribute.
           *
           * @param {string} _name Attribute name
           * @param {string|function} _filter filter or function to register
           * @param {mixed} _filterParam Misc filter parameter
           * @param {boolean} _chain If true, filter is chained to the current attribute filter.
           * @return {object} self
           */
          attrEncoder: function(_name, _filter, _filterParam, _chain) {
            if(typeof _filter === 'string') {
              var filter = $filter(_filter);
              // TODO: if(!_filter) throw $setupError
              _filter = function(_value) { return filter(_value, _filterParam); };
            }

            encoders[_name] = _chain ? chain(encoders[_name], _filter) : _filter;
            return this;
          },

          /// Relations

          /**
           * Registers a model hasMany relation
           *
           * The `_model` attribute supports both a string (using injector) o
           * a direct restmod Model type reference.
           *
           * @param {string}  _name Attribute name
           * @param {string|object} _model Other model
           * @param {string} _url Partial url
           * @return {object} self
           */
          hasMany: function(_name, _model, _alias) {
            return this.attrDefault(_name, function() {
              if(typeof _model === 'string') _model = $injector.get(_model); // inject type (only the first time...)
              return _model.$collection(null, _alias || Utils.snakecase(_name, '-'), this); // TODO: put snakecase transformation in URLBuilder
            }).attrDecoder(_name, function(_raw) {
              this[_name].$feed(_raw);
            });
          },
          /**
           * Registers a model hasOne relation
           *
           * The `_model` attribute supports both a string (using injector) o
           * a direct restmod Model type reference.
           *
           * @param {string}  _name Attribute name
           * @param {string|object} _model Other model
           * @param {string} _url Partial url
           * @return {object} self
           */
          hasOne: function(_name, _model, _partial) {
            return this.attrDefault(_name, function() {
              if(typeof _model === 'string') _model = $injector.get(_model); // inject type (only the first time...)
              return new _model(null, _partial || Utils.snakecase(_name, '-'), this); // TODO: put snakecase transformation in URLBuilder
            }).attrDecoder(_name, function(_raw) {
              this[_name].$decode(_raw);
            });
          },

          /// Prototype extensions.

          /**
           * Registers an instance method
           *
           * Usage:
           *    builder.define(function(_super) {
           *      return $fetch()
           *    });
           *
           * It is posible to override an existing method using define,
           * if overriden, the old method can be called using `this.$super`
           * inside de new method.
           *
           * @param {string} _name Method name
           * @param {function} _fun
           * @return {object} self
           */
          define: function(_name, _fun) {
            if(typeof _name === 'string') {
              Model.prototype[_name] = Utils.override(Model.prototype[_name], _fun);
            } else {
              Utils.extendOverriden(Model.prototype, _name);
            }
            return this;
          },
          /**
           * Registers a class method
           *
           * It is posible to override an existing method using define,
           * if overriden, the old method can be called using `this.$super`
           * inside de new method.
           *
           * @param {string} _name Method name
           * @param {function} _fun
           * @return {object} self
           */
          classDefine: function(_name, _fun) {
            if(typeof _name === 'string') {
              Model[_name] = Utils.override(Model[_name], _fun);
            } else {
              Utils.extendOverriden(Model, _name);
            }
            return this;
          },
          /**
           * Adds an event hook
           *
           * Hooks are used to extend or modify the model behavior, and are not
           * designed to be used as an event listening system.
           *
           * The given function is executed in the hook's context, different hooks
           * make different parameters available to callbacks.
           *
           * @param {string} _hook The hook name, refer to restmod docs for builtin hooks.
           * @param {function} _do function to be executed
           * @return {object} self
           */
          on: function(_hook, _do) {
            var cbs = callbacks[_hook];
            if(!cbs) cbs = callbacks[_hook] = [];
            cbs.push(_do);
            return this;
          },

          beforeSave: function(_do) { return this.on('before_save', _do); },
          beforeCreate: function(_do) { return this.on('before_create', _do); },
          afterCreate: function(_do) { return this.on('after_create', _do); },
          beforeUpdate: function(_do) { return this.on('before_update', _do); },
          afterUpdate: function(_do) { return this.on('after_update', _do); },
          afterSave: function(_do) { return this.on('after_save', _do); },
          beforeDestroy: function(_do) { return this.on('before_destroy', _do); },
          afterDestroy: function(_do) { return this.on('after_destroy', _do); },
          afterFeed: function(_do) { return this.on('after_feed', _do); },
          beforeRender: function(_do) { return this.on('before_render', _do); },

          /// Experimental modifiers

          /**
           * Volatile attributes are reset after being rendered.
           *
           * @param {string}  _name Attribute name
           * @param  {[type]} _isVolatile Default/Reset value
           * @return {object} self
           */
          attrVolatile: function(_attr, _init) {
            return this.attrDefault(_attr, _init).attrEncoder(_attr, function(_value) {
              // Not sure about modifying object during encoding
              this[_attr] = isFunction(_init) ? _init.call(this) : _init;
              return _value;
            }, null, true);
          },
          /**
           * Expression attributes are evaluated every time new data is fed to the model.
           *
           * @param {string}  _name Attribute name
           * @param {string} _expr Angular expression to evaluate
           * @return {object} self
           */
          attrExpression: function(_name, _expr) {
            var filter = $parse(_expr);
            this.on('after_feed', function() {
              this[_name] = filter(this);
            });
          }
        };

        loadMeta(BASE_CHAIN, Builder);
        loadMeta(Model.$meta, Builder);

        /*
         * Mixin post-processing phase
         */

        // by default use the restUrlBuilder
        urlBuilder = (urlBuilderFactory || $injector.get('restUrlBuilderFactory')())(_urlParams);

        // TODO postprocessing of collection prototype.

        return Model;
      };

      /**
       * Returns an abstract model.
       *
       * An abstract model is just a metadata container that can be included in a mixin chain.
       *
       * @return {object} The abstract model
       */
      restmod.abstract = function(/* mixins */) {
        return { $isAbstract: true, $meta: arraySlice.call(arguments, 0) };
      };

      return restmod;
    }]
  };
})
// make SyncMask available as constant
.constant('SyncMask', SyncMask);

