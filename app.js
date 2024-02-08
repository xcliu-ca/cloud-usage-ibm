const Koa = require('koa')
const bodyParser = require("koa-bodyparser")
const vcore = require("@vueuse/core")
const execa = require("execa")
const chalk = require("chalk")
const { ref, computed, watch } = require("vue")
const { WebClient } = require('@slack/web-api')
// console.log(Object.keys(vmath))
// console.log(Object.keys(execa))

// constants
const MAP_ACTIONS0 = {
  "ciddread@us.ibm.com": {mention: "<!subteam^SCSNVULBD>", notify: 3, cleanup: 4}, // need group id
  "c3cvt3vm@ca.ibm.com": {mention: "<!subteam^SN8N9QUF9>", notify: 8}, // need group id
  // "unknown@ibm.com": {mention: "<@" + process.env.SLACK_MENTION + ">", notify: 4}
}
const MAP_ACTIONS = Object.assign({}, MAP_ACTIONS0)
Object.keys(MAP_ACTIONS0).forEach(key => MAP_ACTIONS[key.replace(/@/,"-at-")] = MAP_ACTIONS0[key])
// reactive variables 
const ibm_query_ec2 = ref({})
const ibm_query_vpc = ref({})
const ibm_query_volume = ref({})
const ibm_query_s3 = ref({})
const ibm_ec2 = ref({})
const ibm_vpc = ref({})
const ibm_volume = ref([])
const ibm_s3 = ref([])
const ibm_cost_estimate = ref({Amount: "estimation_cost"})
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
  .filter(instance => instance.State && instance.State.Name === "running")
)

// compute ec2 clusters
const ibm_ec2_clusters = computed(() => ibm_ec2_active.value // roks + k8s 
  .filter(instance => {
    return instance.Tags.findIndex(tag => tag.Key === "Name" || tag.Key === "name") !== -1 &&
    (instance.Tags.findIndex(tag => tag.Key === "Owner" || tag.Key === "owner") !== -1 &&
    instance.Tags.findIndex(tag => tag.Key === "Cluster" || tag.Key === "cluster") !== -1 ||
    instance.Tags.findIndex(tag => tag.Key === "red-hat-managed") !== -1 ||
    instance.Tags.findIndex(tag => tag.Key === "eks:cluster-name") !== -1)
  })
  .map(instance => {
    instance.name = instance.Tags.find(tag => tag.Key === "Name" || tag.Key === "name").Value
    const tag_owner = instance.Tags.find(tag => tag.Key === "Owner" || tag.Key === "owner")
    const tag_cluster = instance.Tags.find(tag => tag.Key === "Cluster" || tag.Key === "cluster")
    if (tag_owner && tag_cluster) {
      instance.owner = tag_owner.Value.replace(/-at-/,"@").toLowerCase()
      instance.cluster = tag_cluster.Value.toLowerCase()
    } else if (instance.Tags.findIndex(tag => tag.Key === "red-hat-managed") !== -1) {
      // rosa cluster
      if (/cicd-/.test(instance.name)) {
        instance.owner = (tag_owner?.Value || "cicdread@us.ibm.com").replace(/-at-/,"@").toLowerCase()
      } else if (/sert-/.test(instance.name)) {
        instance.owner = (tag_owner?.Value || "c3cvt3vm@ca.ibm.com").replace(/-at-/,"@").toLowerCase()
      } else {
        instance.owner = (tag_owner?.Value || "unknown@ibm.com").replace(/-at-/,"@").toLowerCase()
      }
      instance.cluster = (tag_cluster?.Value || instance.name.replace(/-infra-.*/,"").replace(/-worker-.*/,"").replace(/-master-.*/,"")).toLowerCase()
    } else if (instance.Tags.findIndex(tag => tag.Key === "eks:cluster-name") !== -1) {
      if (/cicd-|prow-/.test(instance.name)) {
        instance.owner = (tag_owner?.Value || "cicdread@us.ibm.com").toLowerCase()
      } else if (/sert-/.test(instance.name)) {
        instance.owner = (tag_owner?.Value || "c3cvt3vm@ca.ibm.com").toLowerCase()
      } else {
        instance.owner = (tag_owner?.Value || "unknown@ibm.com").toLowerCase()
      }
      instance.cluster = (tag_cluster?.Value || instance.Tags.find(tag => tag.Key === "eks:cluster-name").Value).toLowerCase()
    } else {
      instance.owner = (tag_owner?.Value || "unknown@ibm.com").toLowerCase()
      instance.cluster = (tag_cluster?.Value || "unknown-cluster").toLowerCase()
    }
    const tag = instance.Tags.find(tag => tag.Key === "Spending_Env" || tag.Key === "spending_env")
    if (tag) {
      instance.spendingenv = tag.Value.toLowerCase()
    } else {
      instance.spendingenv = "test"
    }
    // console.log(instance)
    return instance
  })
  .sort((x,y) => x.name > y.name ? 1 : -1)
  .reduce(reduce_cluster, {})
) 
// compute all active clusters
const clusters_active = computed(() => Object.entries(ibm_ec2_clusters.value)
    .map(([cluster,members]) => ({
      name: cluster,
      owner: members.at(0).owner,
      launch: members.at(0).LaunchTime,
      vpc: members.at(0).VpcId,
      type: members.at(0).InstanceType,
      // owner: members.map(i => i.owner).filter((value, index, array) => array.indexOf(value) === index),
      // vpc: members.map(i => i.VpcId).filter((value, index, array) => array.indexOf(value) === index),
      spending: members.at(0).spendingenv,
      instances: members.length
    }))
)
const clusters_notify = computed(() => clusters_active.value
  .filter(c => c.spending === "test")
  .filter(c => new Date() - new Date(c.launch) > (MAP_ACTIONS.hasOwnProperty(c.owner) ? MAP_ACTIONS[c.owner].notify : 24) * 60 * 60 * 1000)
)

// periodically refresh querys and status
status().then(() => refresh()).then(() => status())
const interval_refresh = setInterval(refresh, 10 * 60 * 1000)
const interval_status = setInterval(status, 3 * 60 * 1000)
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
vcore.watchDeep(ibm_ec2, () => {
  console.log(`total ec2 instances: ${Object.keys(ibm_ec2.value).length}`)
  print_instances()
  setTimeout(() => console.log(clusters_active.value), 100)
  // setTimeout(() => Object.values(ibm_ec2.value).forEach(i => console.log(i.Tags.find(t => t.Key === "Name"))), 5000)
})

// process aws query results
watch(ibm_query_vpc, () => {
  ibm_vpc.value = {}
  ibm_query_vpc.value["Vpcs"].forEach(vpc => ibm_vpc.value[vpc["VpcId"]] = vpc)
  // Object.keys(ibm_vpc.value).forEach(key => console.log(key))
})
watch(ibm_query_volume, () => {
  ibm_volume.value = ibm_query_volume.value["Volumes"]
})
watch(ibm_query_s3, () => {
  ibm_s3.value = ibm_query_s3.value.split('\n')
})
watch(ibm_query_ec2, () => {
  Object.keys(ibm_query_ec2.value).forEach(key => {
    ibm_query_ec2.value[key].forEach(reservation => {
      reservation.Instances.forEach(i => {
        ibm_ec2.value[i.InstanceId] = i
      })
    })
  })
})

// for koa application
function APIError (code, message) {
  this.code = code || 'internal:unknown_error'
  this.message = message || ''
  this.flag_ibmcloud_working = flag_ibmcloud_working.value
  this.flag_slack_working = flag_slack_working.value
  this.estimated_cost = ibm_cost_estimate.value.Amount
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
      flag_ibmclou_working: flag_ibmcloud_working.value,
      flag_slack_working: flag_slack_working.value,
      estimated_cost: ibm_cost_estimate.value.Amount
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
      estimated_cost: ibm_cost_estimate.value.Amount
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
  } catch (e) {}
}

// function to refresh with imagecontentsourcepolicy and global pull secret
async function refresh () {
  console.log(chalk.green(`... refreshing information`))
  try {
    ibm_cost_estimate.value = JSON.parse((await execa.command(`aws ce get-cost-forecast --time-period Start=${new Date().toJSON().replace(/T.*/,"")},End=${new Date(new Date().setFullYear(new Date().getFullYear(), new Date().getMonth() + 1,0)).toJSON().replace(/T.*/,"")} --metric=UNBLENDED_COST --granularity=MONTHLY`, {shell: true})).stdout).Total
  } catch (e) {}
  try {
    ibm_query_vpc.value = JSON.parse((await execa.command('aws ec2 describe-vpcs', {shell: true})).stdout)
    flag_ibmcloud_working.value = true
  } catch (e) {
    flag_ibmcloud_working.value = false
    console.error(e)
  }
  try {
    ibm_query_volume.value = JSON.parse((await execa.command('aws ec2 describe-volumes', {shell: true})).stdout)
    flag_ibmcloud_working.value = true
  } catch (e) {
    flag_ibmcloud_working.value = false
    console.error(e)
  }
  try {
    ibm_query_s3.value = (await execa.command('aws s3 ls', {shell: true})).stdout.trim()
    flag_ibmcloud_working.value = true
  } catch (e) {
    flag_ibmcloud_working.value = false
    console.error(e)
  }
  try {
    ibm_query_ec2.value = JSON.parse((await execa.command('aws ec2 describe-instances', {shell: true})).stdout)
    flag_ibmcloud_working.value = true
  } catch (e) {
    flag_ibmcloud_working.value = false
    console.error(e)
  }
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
  }, { throttle: 60 * 60 * 1000 }
)
vcore.watchThrottled(code_status, () => {
    slack.chat.postMessage({text: code_status.value, channel: channel.value})
      .then(() => flag_slack_working.value = true).catch(() => flag_slack_working.value = false)
  }, { throttle: 3 * 60 * 60 * 1000 }
)

watch(clusters_notify, () => {
    if (clusters_notify.value.length > 0) {
      subject.value = `:warning: long running aws clusters`
      clusters_notify.value.map(c => c.owner).filter((value, index, array) => array.indexOf(value) === index).forEach(owner => subject.value += ` ${MAP_ACTIONS.hasOwnProperty(owner) ? MAP_ACTIONS[owner].mention : "<@${process.env.SLACK_MENTION}>"} `)
      // code.value = JSON.stringify(clusters_notify.value.map(c => Object.assign({}, c, {launch: vcore.useTimeAgo(new Date(c.launch)).value})), "", 2)
      code.value = clusters_notify.value.map(cluster => cluster.name.padEnd(24) + cluster.owner.padEnd(24) + cluster.spending.padEnd(12) + cluster.instances + " x " + cluster.type.padEnd(16) + vcore.useTimeAgo(new Date(cluster.launch)).value).join("\n")
    }
})

watch(clusters_active, () => {
  if (clusters_active.value.length > 0) {
    code_status.value = `:info_2: current active aws clusters [vpcs: ${Object.keys(ibm_vpc.value).length} volumes: ${ibm_volume.value.length} buckets: ${ibm_s3.value.length} estimates :heavy-dollar-sign-emoji:${ibm_cost_estimate.value.Amount.replace(/\..*/,"")}]\n
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
