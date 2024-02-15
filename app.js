const Koa = require('koa')
const bodyParser = require("koa-bodyparser")
const vcore = require("@vueuse/core")
const execa = require("execa")
const chalk = require("chalk")
const { ref, computed, watch } = require("vue")
const { WebClient } = require('@slack/web-api')
const AsyncForEach = require("async-await-foreach")
// console.log(Object.keys(vmath))
// console.log(Object.keys(execa))

// constants
const MAP_ACTIONS0 = {
  "ciddread@us.ibm.com": {mention: "<!subteam^SCSNVULBD>", notify: 3, cleanup: 4}, // need group id
  "c3cvt3vm@ca.ibm.com": {mention: "<!subteam^SN8N9QUF9>", notify: 8}, // need group id
  // "unknown@ibm.com": {mention: "<@" + process.env.SLACK_MENTION + ">", notify: 4}
}
const REGIONS = (process.env.IBM_CLOUD_REGIONS || "ca-tor,us-east,us-south").split(",")
const MAP_ACTIONS = Object.assign({}, MAP_ACTIONS0)
Object.keys(MAP_ACTIONS0).forEach(key => MAP_ACTIONS[key.replace(/@/,"-at-")] = MAP_ACTIONS0[key])
// reactive variables 
const ibm_tags = ref([])
const ibm_query_ec2 = ref({Instances: []})
const ibm_query_volume = ref({Volumes: []})
const ibm_query_s3 = ref({})
const ibm_ec2 = ref({})
const ibm_vpc = ref({})
const ibm_volume = ref([])
const ibm_s3 = ref([])
const ibm_cost_estimate = ref({resources: {billable_cost: "estimation_cost"}})
const ibm_ec2_clusters = ref([])
// global flags
const flag_ibmcloud_working = ref(false)
const flag_slack_working = ref(false)

// slack related
const slack = new WebClient(process.env.SLACK_TOKEN)
const channel = ref(process.env.SLACK_CHANNEL || "#private-xcliu")
const subject = ref(`Some slack message <@${process.env.SLACK_MENTION}>`)
const code = ref('console.log("hello slack")')
const code_status = ref('console.log("hello slack")')
const text = computed(() => `${subject.value}\n\`\`\`\n${code.value}\n\`\`\`\n`)

// compute ec2 instances
const ibm_ec2_active = computed(() => Object.values(ibm_ec2.value)
  .filter(instance => instance.status && instance.status === "running")
)

// compute all active clusters
const clusters_active = computed(() => {
  console.log(`... ibm_ec2_clusters changed, calculating clusters active`)
  ibm_ec2_clusters.value
    .forEach(cluster => {
      cluster.spending = cluster.hasOwnProperty("spending_env") ? cluster.spending_env : "test"
      cluster.owner = cluster.hasOwnProperty("owner") ? cluster.owner : "unknown"
      cluster.type = cluster.worker_pool.at(0).hasOwnProperty("machineType") ? cluster.worker_pool.at(0).machineType : cluster.worker_pool.at(0).hasOwnProperty("flavor") ? cluster.worker_pool.at(0).flavor : "unknown"
      cluster.vpc = cluster.worker_pool.at(0).hasOwnProperty("vpcID") ? cluster.worker_pool.at(0).vpcID : "classic"
      cluster.instances = cluster.hasOwnProperty("workerCount") ? cluster.workerCount : 1
    })
  return ibm_ec2_clusters.value
    .map(cluster => ({
      name: cluster.name,
      owner: cluster.owner,
      launch: cluster.createdDate,
      vpc: cluster.vpc,
      type: cluster.type.replace(/.encrypted/i, ""),
      spending: cluster.spending,
      instances: cluster.instances
    }))
  }
)
const clusters_notify = computed(() => clusters_active.value
  .filter(c => new Date() - new Date(c.launch) > (MAP_ACTIONS.hasOwnProperty(c.owner) ? MAP_ACTIONS[c.owner].notify : 24) * 60 * 60 * 1000)
  // .filter(c => c.spending === "test")
)

// periodically refresh querys and status
status().then(() => refresh()).then(() => status())
const interval_refresh = setInterval(refresh, 1 * 60 * 1000)
const interval_status = setInterval(status, 19 * 1000)
if (process.env.RUN_ONCE === "yes") { terminate() }

vcore.watchDeep(ibm_vpc, () => {
  console.log(`total vpc instances: ${Object.keys(ibm_vpc.value).length}`)
})
watch(ibm_volume, () => {
  console.log(`total volumes: ${ibm_volume.value.length}`)
})
watch(ibm_s3, () => {
  console.log(`total buckets: ${ibm_s3.value.length}`)
})
// vcore.watchDeep(ibm_ec2, () => {
//   console.log(`total ec2 instances: ${Object.keys(ibm_ec2.value).length}`)
//   print_instances()
//   setTimeout(() => console.log(clusters_active.value), 100)
//   // setTimeout(() => Object.values(ibm_ec2.value).forEach(i => console.log(i.Tags.find(t => t.Key === "Name"))), 5000)
// })

// process ibmcloud query results
vcore.watchDeep(ibm_query_volume, () => {
  ibm_volume.value = ibm_query_volume.value["Volumes"]
})
watch(ibm_query_s3, () => {
  ibm_s3.value = ibm_query_s3.value.split('\n')
})
vcore.watchDeep(ibm_query_ec2, () => {
  ibm_query_ec2.value.Instances.forEach(i => {
    ibm_ec2.value[i.id] = i
  })
})

// for koa application
function APIError (code, message) {
  this.code = code || 'internal:unknown_error'
  this.message = message || ''
  this.flag_ibmcloud_working = flag_ibmcloud_working.value
  this.flag_slack_working = flag_slack_working.value
  this.estimated_cost = ibm_cost_estimate.value.resources.billable_cost
}

const app = new Koa();
app.use(bodyParser())

// save parameters
app.use(async (ctx, next) => {
  ctx.body = ctx.request.body
  ctx.response.type = 'application/json'
  ctx.response.status = 200
  await next()
})

// install restify
app.use(async (ctx, next) => {
  ctx.rest = (data) => {
    ctx.response.body = Object.assign(data, {
      flag_ibmcloud_working: flag_ibmcloud_working.value,
      flag_slack_working: flag_slack_working.value,
      estimated_cost: ibm_cost_estimate.value.resources.billable_cost,
      vpcs: Object.keys(ibm_vpc.value).length,
      volumes: ibm_volume.value.length
    })
  }
  try {
    await next()
  } catch (e) {
    ctx.response.status = 400
    ctx.response.body = {
      code: e.code || 'internal:unknown_error',
      message: e.message || '',
      flag_ibmcloud_working: flag_ibmcloud_working.value,
      flag_slack_working: flag_slack_working.value,
      estimated_cost: ibm_cost_estimate.value.resources.billable_cost
    }
  }
})

// answer request
app.use(async (ctx, next) => {
  await next()
  ctx.rest({})
});

// ibmcloud cli health
app.use(async (ctx, next) => {
  if (!flag_ibmcloud_working.value) {
    throw new APIError('env:cli', 'ibmcloud can not query')
  }
  await next()
});

const server = app.listen(3000);
console.log(chalk.cyan('api started at port 3000...'))

// function to query status
async function status(url_addr="http://127.0.0.1:3000", timeout=20) {
  console.log(chalk.green(`... querying status`))
  try {
    const result = await execa.command('curl localhost:3000', {shell: true})
    console.log(JSON.parse(result.stdout))
    // console.log(clusters_active.value)
    console.log(code.value)
    console.log(code_status.value)
    console.log(ibm_tags.value)
  } catch (e) {}
}

// function to refresh with imagecontentsourcepolicy and global pull secret
async function refresh () {
  console.log(chalk.green(`... refreshing information`))
  ibm_vpc.value = {}
  ibm_query_volume.value["Volumes"] = []
  ibm_query_ec2.value["Instances"] = []
  try {
    ibm_cost_estimate.value = JSON.parse((await execa.command(`ibmcloud billing account-usage --output JSON`, {shell: true})).stdout).Summary
    console.log(ibm_cost_estimate.value)
  } catch (e) {}
  await AsyncForEach(REGIONS, async (region) => {
    try {
      await execa.command(`ibmcloud target -r ${region}`, {shell: true})
      JSON.parse((await execa.command(`ibmcloud is vpcs --output JSON`, {shell: true})).stdout).forEach(vpc => ibm_vpc.value[vpc.id] = vpc) 
      JSON.parse((await execa.command('ibmcloud is volumes --output JSON', {shell: true})).stdout).forEach(volume => ibm_query_volume.value.Volumes.push(volume) )
      JSON.parse((await execa.command('ibmcloud is instances --output JSON', {shell: true})).stdout).forEach(instance => ibm_query_ec2.value.Instances.push(instance) )
      flag_ibmcloud_working.value = true
    } catch (e) {
      flag_ibmcloud_working.value = false
      console.error(e)
    }
  })
  await async_query_clusters()
  await async_query_tags()
  // try {
  //   ibm_query_s3.value = (await execa.command('aws s3 ls', {shell: true})).stdout.trim()
  //   flag_ibmcloud_working.value = true
  // } catch (e) {
  //   flag_ibmcloud_working.value = false
  //   console.error(e)
  // }
}

// query ibm tags
const async_query_tags = async () => {
  try {
    const q_tags = await execa.command(`ibmcloud resource tags -a true --output json`, {shell: true})
    const tags = JSON.parse(q_tags.stdout).items.filter(tag => /owner:|spending_env|squad:/.test(tag.name))
    tags.forEach(tag => tag.new_tag = ibm_tags.value.findIndex(t => t.name === tag.name) === -1)
    // clean tags
    ibm_tags.value.forEach(tag => tag.exists = tags.findIndex(t => t.name === tag.name) !== -1)
    ibm_tags.value = ibm_tags.value.filter(tag => tag.exists)
    // refresh tags
    await AsyncForEach(tags, async (tag) => {
      try {
        const query = await execa.command(`ibmcloud resource search 'tags:"${tag.name}"' --output json`, {shell: true})
        tag.items = JSON.parse(query.stdout).items.filter(item => /k8-cluster/.test(item.type))
        if (tag.new_tag) {
          ibm_tags.value.unshift(tag)
        } else {
          ibm_tags.value.splice(ibm_tags.value.findIndex(t => t.name === tag.name), 1, tag)
        }
      } catch (e) { console.error(e) }
    })
  } catch (e) { console.log(e) }
}
// query ks clusters
const async_query_clusters = async () => {
  try {
    const q_classic = await execa.command(`ibmcloud ks cluster ls --output json`, {shell: true})
    const q_vpcgen2 = await execa.command(`ibmcloud ks cluster ls --provider vpc-gen2 --output json`, {shell: true})
    const q_clusters = JSON.parse(q_classic.stdout).concat(JSON.parse(q_vpcgen2.stdout))
    q_clusters.forEach(cluster => cluster.new_cluster = ibm_ec2_clusters.value.findIndex(c => c.id === cluster.id) === -1)
    // clean clusters
    ibm_ec2_clusters.value.forEach(cluster => cluster.exists = q_clusters.findIndex(c => c.id === cluster.id) !== -1)
    ibm_ec2_clusters.value = ibm_ec2_clusters.value.filter(cluster => cluster.exists)
    // refresh clusters
    await AsyncForEach(q_clusters, async (cluster) => {
      try {
        const query = await execa.command(`ibmcloud ks worker-pool ls -c ${cluster.name} --output json`, {shell: true})
        cluster.worker_pool = JSON.parse(query.stdout)
        if (cluster.new_cluster) {
          ibm_ec2_clusters.value.unshift(cluster)
        } else {
          ibm_ec2_clusters.value.splice(ibm_ec2_clusters.value.findIndex(c => c.id === cluster.id), 1, cluster)
        }
      } catch (e) { console.error(e) }
    })
  } catch (e) { console.log(e) }
}

// reduce instances array to cluster object 
function reduce_cluster (acc, value) { // each value is an instance
  if (acc.hasOwnProperty(value.cluster)) {
    acc[value.cluster].push(value)
    acc[value.cluster].sort(sortInstanceType)
  } else {
    acc[value.cluster] = [ value ]
  }
  return acc
}

// print running ec2 instances
function print_instances () {
  const ec2s = []
  ibm_ec2_active.value.forEach(instance => {
    const tag_name = instance.Tags.findIndex(tag => tag.Key === "Name" || tag.Key === "name")
    if (tag_name !== -1) {
      ec2s.push(instance.Tags[tag_name].Value)
    }
  })
  console.log(ec2s.sort())
}

// print running iks cluster
function print_clusters () {
  const ec2s = []
  ibm_ec2_active.value.forEach(instance => {
    const tag_name = instance.Tags.findIndex(tag => tag.Key === "Name" || tag.Key === "name")
    if (tag_name !== -1) {
      ec2s.push(instance.Tags[tag_name].Value)
    }
  })
  console.log(ec2s.sort())
}
// function terminate the whole app
function terminate() {
  setTimeout(() => {
    console.log(chalk.red(`... terminating app`))
    server.close()
    clearInterval(interval_refresh)
    clearInterval(interval_status)
  }, 60 * 1000)
}

// send slack notifications
const blocks = computed(() => [
  {
    type: "section",
    text: { type: "mrkdwn", text: subject.value }
  },
  {
    type: "section",
    text: { type: "mrkdwn", text: `\`\`\`\n${code.value}\n\`\`\`\n` }
  }
])
vcore.watchThrottled(code, () => {
    console.log(code.value)
    slack.chat.postMessage({blocks: JSON.stringify(blocks.value), text: text.value, channel: channel.value})
      .then(() => flag_slack_working.value = true).catch(() => flag_slack_working.value = false)
  }, { throttle: 1 * 60 * 1000 }
)
vcore.watchThrottled(code_status, () => {
    slack.chat.postMessage({text: code_status.value, channel: channel.value})
      .then(() => flag_slack_working.value = true).catch(() => flag_slack_working.value = false)
  }, { throttle: 1 * 1 * 60 * 1000 }
)

watch(clusters_notify, () => {
    if (clusters_notify.value.length > 0) {
      subject.value = `:warning: long running ibmcloud clusters`
      clusters_notify.value.map(c => c.owner).filter((value, index, array) => array.indexOf(value) === index).forEach(owner => subject.value += ` ${MAP_ACTIONS.hasOwnProperty(owner) ? MAP_ACTIONS[owner].mention : "<@${process.env.SLACK_MENTION}>"} `)
      // code.value = JSON.stringify(clusters_notify.value.map(c => Object.assign({}, c, {launch: vcore.useTimeAgo(new Date(c.launch)).value})), "", 2)
      code.value = clusters_notify.value.map(cluster => cluster.name.padEnd(24) + cluster.owner.padEnd(24) + cluster.spending.padEnd(12) + cluster.instances + " x " + cluster.type.padEnd(16) + vcore.useTimeAgo(new Date(cluster.launch)).value).join("\n")
    }
})

watch(clusters_active, () => {
  if (clusters_active.value.length > 0) {
    code_status.value = `:info_2: current active ibmcloud clusters [vpcs: ${Object.keys(ibm_vpc.value).length} volumes: ${ibm_volume.value.length} buckets: ${ibm_s3.value.length} estimates :heavy-dollar-sign-emoji:${Math.floor(ibm_cost_estimate.value.resources.billable_cost)}]\n
\`\`\`
${clusters_active.value.map(cluster => cluster.name.padEnd(24) + cluster.owner.padEnd(24) + cluster.spending.padEnd(12) + cluster.instances + " x " + cluster.type.padEnd(16) + vcore.useTimeAgo(new Date(cluster.launch)).value).join("\n")}
\`\`\`
`
  }
})

if (process.env.RUN_ONCE !== "yes") {
  const mcode = JSON.stringify(MAP_ACTIONS0,"", 2).replace(/..subteam./g,"mention-")
  slack.chat.postMessage({
    text: `:info_2: configuration\n
\`\`\`
${mcode}
\`\`\`
`,
    channel: channel.value
  }).then(() => flag_slack_working.value = true)
    .catch(() => flag_slack_working.value = false)
}

function sortInstanceType(x, y) { // x, y ec2 instances
  const part_x = x.InstanceType.split(".")[1]
  const part_y = y.InstanceType.split(".")[1]
  if (/[0-9]+xlarge/.test(part_x) && /[0-9]+xlarge/.test(part_y)) {
    const power_x = part_x.replace(/xlarge/,"")
    const power_y = part_y.replace(/xlarge/,"")
    return power_y - power_x
  } else if (/xlarge/.test(part_x) && !/xlarge/.test(part_y)) {
    return -1
  } else if (!/xlarge/.test(part_x) && !/xlarge/.test(part_y)) {
    return 1
  } else if (/large/.test(part_x) && !/large/.test(part_y)) {
    return -1
  } else if (!/large/.test(part_x) && /large/.test(part_y)) {
    return 1
  } else {
    return part_x > part_y ? 1 : -1
  }
}
